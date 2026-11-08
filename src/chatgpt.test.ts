import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { chatGPTError, chatGPTModels, parseChatGPTStream } from './providers/chatgpt-protocol.ts';
import { installChatGPTCapture } from './providers/chatgpt-browser.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { ChatGPTProvider, fillChatGPTEditor } from './providers/chatgpt.ts';
import { getProvider } from './providers/registry.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

const sse = (value: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
const snapshot = (text: string, extra: any = {}) => ({ message: { id: 'answer', author: { role: 'assistant' },
  content: { content_type: 'text', parts: [text] }, ...extra } });
async function* chunks(text: string, size = 1) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };

test('ChatGPT catalog and routing do not advertise locked or invented models', () => {
  assert.equal(providerId('chatgpt'), 'chatgpt'); assert.equal(providerIdForModel('chatgpt/auto'), 'chatgpt');
  assert.equal(providerIdForModel('gpt-unknown'), null);
  assert.deepEqual(chatGPTModels({ models: [{ slug: 'fixture', title: 'Fixture' }, { slug: 'locked', title: 'Locked', disabled: true }] }),
    [{ id: 'chatgpt/fixture', label: 'Fixture', contextLength: 0 }]);
  assert.deepEqual(chatGPTModels({ data: [] }), []);
  const args = interactiveWorkerArguments('/profile', 'https://chatgpt.com/');
  assert.equal(args.at(-1), 'https://chatgpt.com/'); assert.ok(!args.some(a => a.includes('remote-debugging')));
  assert.equal(chatGPTError(403).status, 403); assert.doesNotMatch(chatGPTError(403).message, /suspended|login/);
  assert.match(chatGPTError(403, 'account_deactivated').message, /account is suspended/);
  assert.equal(chatGPTError(502, 'rate_limit_exceeded').status, 429);
});

test('ChatGPT quota deadline survives guard restart without expiring authentication', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chatgpt-quota-'));
  try {
    const file = path.join(directory, 'guard.json');
    const guard = new GenerationGuard(file, () => 1000);
    guard.defer(120000, 'rate_limit');
    const restored = new GenerationGuard(file, () => 2000);
    assert.equal(restored.status().block, null);
    assert.equal(restored.status().rateLimitUntil, new Date(121000).toISOString());
    assert.equal(restored.status().nextAllowedAt, new Date(121000).toISOString());
    const expired = new GenerationGuard(file, () => 122000);
    assert.equal(expired.status().rateLimitUntil, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ChatGPT cumulative SSE preserves repeated text, formatting, CRLF and split Unicode', async () => {
  const input = (sse(snapshot('Olá')) + sse(snapshot('Olá Olá\n```ts\nx()\n```')) + 'data: [DONE]\n\n').replace(/\n/g, '\r\n');
  const values = await collect(parseChatGPTStream(chunks(input)));
  assert.equal(values.filter(v => v.type === 'content').map(v => v.text).join(''), 'Olá Olá\n```ts\nx()\n```');
  assert.equal(values.filter(v => v.type === 'finish').length, 1);
});

test('ChatGPT v1 deltas inherit path/op per stream, keep channels separate and ignore non-final messages', async () => {
  const stream = sse('v1', 'delta_encoding') +
    sse({ v: snapshot('ha') }, 'delta') +
    sse({ p: '/message/content/parts/0', o: 'append', v: 'ha' }, 'delta') +
    sse({ v: 'ha' }, 'delta') +
    sse({ c: 1, p: '', o: 'add', v: snapshot('private', { channel: 'analysis', id: 'analysis' }) }, 'delta') +
    sse({ c: 0, p: '', o: 'patch', v: [{ p: '/message/content/parts/0', o: 'append', v: '!' }] }, 'delta') +
    sse({ type: 'message_stream_complete' });
  const values = await collect(parseChatGPTStream(chunks(stream, 3)));
  assert.deepEqual(values, [{ type: 'content', text: 'ha' }, { type: 'content', text: 'ha' },
    { type: 'content', text: 'ha' }, { type: 'content', text: '!' }, { type: 'finish' }]);
});

test('ChatGPT decoding fails explicitly on unsafe paths, truncation, malformed data and upstream errors', async () => {
  for (const input of [sse('v2', 'delta_encoding'), sse({}, 'delta'), 'data: nope\n\n', sse(snapshot('unfinished')),
    sse('v1', 'delta_encoding') + sse({ p: '/__proto__/polluted', v: true }, 'delta'),
    sse(snapshot('abc')) + sse(snapshot('ab'))]) {
    await assert.rejects(() => collect(parseChatGPTStream(chunks(input))), UpstreamError);
  }
  assert.equal(({} as any).polluted, undefined);
  await assert.rejects(() => collect(parseChatGPTStream(chunks(sse({ error: { code: 'rate_limit_exceeded' } })))), (e: any) => e.status === 429);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(parseChatGPTStream(chunks(sse(snapshot('text'))), controller.signal)));
});

test('ChatGPT decoded tool calls use the shared OpenAI parser', async () => {
  const text = '<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
  const parsed = await parseProviderStreamToOpenAI(parseChatGPTStream(chunks(sse(snapshot(text)) + 'data: [DONE]\n\n')),
    'chatcmpl-fixture', 'chatgpt/auto', 10, [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });
});

test('ChatGPT browser capture ignores prepare/other prompts, enforces model and cancels the real request', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://chatgpt.com/', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('https://chatgpt.com/');
    await page.evaluate(() => {
      (globalThis as any).originalCalls = [];
      globalThis.fetch = async (input, init) => {
        (globalThis as any).originalCalls.push(String(input));
        const body = new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          init?.signal?.addEventListener('abort', () => { (globalThis as any).aborted = true; c.error(new Error('aborted')); });
        } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      };
    });
    await page.evaluate(installChatGPTCapture);
    const result = await page.evaluate(async () => {
      const scope = globalThis as any;
      scope.__proxyChatGPT = { prompt: 'hello', model: 'auto', chunks: [], bytes: 0, done: false };
      const init = { method: 'POST', body: JSON.stringify({ model: 'auto', messages: [{ author: { role: 'user' }, content: { parts: ['hello'] } }] }) };
      await fetch('/backend-api/f/conversation/prepare', init);
      const afterPrepare = !!scope.__proxyChatGPT.claimed;
      const response = await fetch('/backend-api/f/conversation', init);
      const reader = response.body!.getReader(); const first = await reader.read();
      scope.__proxyChatGPT.controller.abort();
      await new Promise(r => setTimeout(r, 10));
      const captured = scope.__proxyChatGPT.chunks.join('');
      scope.__proxyChatGPT = { prompt: 'hello', model: 'specific', chunks: [], bytes: 0, done: false };
      try { await fetch('/backend-api/f/conversation', init); } catch { /* expected mismatch */ }
      return { afterPrepare, first: new TextDecoder().decode(first.value), captured, aborted: scope.aborted,
        mismatch: scope.__proxyChatGPT.error, calls: scope.originalCalls.length };
    });
    assert.equal(result.afterPrepare, false); assert.equal(result.first, 'data: [DONE]\n\n');
    assert.equal(result.aborted, true); assert.equal(result.mismatch, 'model_mismatch'); assert.equal(result.calls, 2);
    assert.equal(result.captured, 'data: [DONE]\n\n');
  } finally { await browser.close(); }
});

test('ChatGPT frontend fixture: authenticated Free account, generation, quota, expiry and guard release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chatgpt-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'chatgpt';
  const browser = await chromium.launch();
  const provider = getProvider() as ChatGPTProvider;
  try {
    const context = await browser.newContext();
    await context.addInitScript(installChatGPTCapture);
    const page = await context.newPage();
    let authenticated = true, quota = false, modernComposer = false;
    const prompts: string[] = [];
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard });
    await page.route('https://chatgpt.com/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/auth/session') return route.fulfill({ json: authenticated ? { user: { id: 'fixture' }, accessToken: 'fixture' } : {} });
      if (pathname === '/backend-api/f/conversation') {
        prompts.push(route.request().postDataJSON().messages[0].content.parts[0]);
        return route.fulfill(quota ?
        { status: 429, headers: { 'retry-after': '120' }, json: { error: { code: 'rate_limit_exceeded' } } } :
        { contentType: 'text/event-stream', body: sse(snapshot('Olá do fixture')) + 'data: [DONE]\n\n' });
      }
      if (modernComposer) return route.fulfill({contentType:'text/html',body:`
        <textarea id="prompt-textarea" hidden></textarea><button data-testid="send-button" hidden>Old send</button>
        <div contenteditable="true" role="textbox">Unrelated editor</div>
        <textarea id="pending-home-input" aria-label="Pergunte ao ChatGPT"></textarea>
        <script>document.getElementById('pending-home-input').onfocus=()=>{
          const form=document.createElement('form');form.setAttribute('data-chatgpt-composer','');
          form.innerHTML='<div contenteditable="true" role="textbox" aria-label="Pergunte ao ChatGPT"></div><button type="submit" aria-label="Enviar" disabled></button>';
          document.getElementById('pending-home-input').replaceWith(form);
          form.querySelector('[contenteditable]').oninput=()=>{form.querySelector('button').disabled=false};
          form.onsubmit=async(event)=>{event.preventDefault();const prompt=form.querySelector('[contenteditable]').innerText;
            const response=await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({model:'auto',messages:[{author:{role:'user'},content:{parts:[prompt]}}]})});await response.text()};
        };</script>`});
      return route.fulfill({ contentType: 'text/html', body: `<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Enviar</button>
        <script>document.querySelector('button').onclick=async()=>{const prompt=document.getElementById('prompt-textarea').innerText;
        const response=await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({model:'auto',messages:[{author:{role:'user'},content:{parts:[prompt]}}]})});await response.text()};</script>` });
    });
    await page.goto('https://chatgpt.com/');
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).authenticated, true);
    assert.deepEqual(await provider.models(), [{ id: 'chatgpt/auto', contextLength: 0 }]);
    const result = await collect(await provider.generate('Teste', 'chatgpt/auto', false));
    assert.equal(result[0].text, 'Olá do fixture'); assert.equal(guard.status().busy, false);
    modernComposer = true;
    const modernResult = await collect(await provider.generate('Teste do editor atual', 'chatgpt/auto', false));
    assert.equal(modernResult[0].text, 'Olá do fixture');
    assert.equal(prompts.at(-1), 'Teste do editor atual');
    assert.equal(await page.locator('#pending-home-input').count(), 0, 'focus hydrates the initial textarea');
    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const models = await (await app.request('/v1/models', { headers })).json();
    assert.equal(models.data[0].id, 'chatgpt/auto');
    assert.equal(models.data[0].context_limit_source, 'unknown');
    assert.equal(models.data[0].max_output_tokens, undefined);
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'chatgpt/auto', stream,
          tools: [{type:'function',function:{name:'lookup',description:'Read the requested information.',parameters:{type:'object',properties:{},additionalProperties:false}}}],
          messages: [
          { role: 'system', content: 'IDE rules: preserve files and use the supplied tools.' },
          { role: 'user', content: 'Primeiro turno' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call-fixture', content: 'Resultado da ferramenta' },
          { role: 'user', content: 'Continue' },
        ] }) });
      assert.equal(response.status, 200); assert.match(await response.text(), /Olá do fixture/);
      assert.match(prompts.at(-1)!, /Resultado da ferramenta/);
      assert.match(prompts.at(-1)!, /^IDE rules: preserve files and use the supplied tools\./);
      assert.match(prompts.at(-1)!, /Tools:.*"name":"lookup"/);
      assert.match(prompts.at(-1)!, /To call a listed tool, output <tool_call>/);
      assert.match(prompts.at(-1)!, /User: Primeiro turno/);
      assert.match(prompts.at(-1)!, /Assistant:.*<tool_call>/s);
      assert.match(prompts.at(-1)!, /Tool Response \(call-fixture\): Resultado da ferramenta/);
    }
    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'chatgpt/auto', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 50 && guard.status().busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.status().busy, false);
    // Disable fixture cooldown without sleeping; production still uses the normal guard.
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    quota = true;
    await assert.rejects(() => collectProvider(provider), (e: any) => e.status === 429);
    assert.equal((await provider.status()).state, 'rate_limited');
    assert.ok(Date.parse(guard.status().nextAllowedAt!) >= Date.now() + 119000);
    assert.equal(guard.status().busy, false);
    authenticated = false;
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    const error = apiError(new UpstreamError('ChatGPT login is required.', 401), 'chatgpt_login_required').error;
    assert.equal(error.help_url, 'https://chatgpt.com/'); assert.match(error.user_action, /Concluir login/);
    assert.doesNotMatch(error.user_action, /DeepSeek|bloqueado em navegadores/);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});
async function collectProvider(provider: ChatGPTProvider) { return collect(await provider.generate('Teste', 'chatgpt/auto', false)); }

test('ChatGPT early manual confirmation reopens login and successful confirmation saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chatgpt-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new ChatGPTProvider();
  let authenticated = false, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://chatgpt.com/**', route => new URL(route.request().url()).pathname === '/api/auth/session' ?
        route.fulfill({ json: authenticated ? { user: { id: 'fixture' }, accessToken: 'fixture' } : {} }) :
        route.fulfill({ contentType: 'text/html', body: '<p>Chat</p>' }));
      await page.goto('https://chatgpt.com/');
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    await assert.rejects(() => provider.finishLogin(), /Conclua o acesso/);
    assert.equal(reopened, 1); assert.equal((await provider.status()).confirmationRequired, true);
    authenticated = true;
    await provider.finishLogin();
    const status = await provider.status();
    assert.equal(status.state, 'authenticated'); assert.equal(status.sessionSaved, true); assert.equal(status.authenticated, true);
    assert.equal(humanRunning, false);
    // A later connect must reuse the already-open automation browser.
    const page = provider.getActivePage(); await provider.initialize(false); assert.equal(provider.getActivePage(), page);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('ChatGPT editor receives multi-line prompts by paste and falls back to typing', async () => {
  const prompt = Array.from({ length: 120 }, (_, i) => `Linha ${i + 1}: contexto do agente da IDE.`).join('\n');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Rich editor with its own paste handling (as ProseMirror): one transaction, one paragraph per line.
    await page.setContent(`<div id="editor" contenteditable="true"></div><script>{
      window.typed = 0;
      const editor = document.getElementById('editor');
      editor.addEventListener('beforeinput', event => { if (event.inputType === 'insertText') window.typed++; });
      editor.addEventListener('paste', event => {
        event.preventDefault();
        editor.replaceChildren(...event.clipboardData.getData('text/plain').split(String.fromCharCode(10)).map(line => {
          const p = document.createElement('p'); p.textContent = line; return p; }));
      });}</script>`);
    assert.equal(await fillChatGPTEditor(page.locator('#editor'), prompt), 'paste');
    assert.equal((await page.locator('#editor').innerText()).replace(/\s+/g, ''), prompt.replace(/\s+/g, ''));
    assert.equal(await page.evaluate(() => (window as any).typed), 0, 'paste must not type the prompt');

    // Plain editable without a paste handler: the synthetic paste inserts nothing, so the text is typed.
    await page.setContent('<div id="editor" contenteditable="true"></div>');
    assert.equal(await fillChatGPTEditor(page.locator('#editor'), prompt), 'fill');
    assert.equal((await page.locator('#editor').innerText()).replace(/\s+/g, ''), prompt.replace(/\s+/g, ''));

    // A long paste becomes a pasted-text file and leaves the box empty. The model would read it
    // as a reference document, so the file is removed and the prompt goes into the message.
    await page.setContent(`<form><div id="chips"></div><div id="editor" contenteditable="true"></div></form><script>{
      const editor = document.getElementById('editor');
      editor.addEventListener('paste', event => {
        event.preventDefault();
        setTimeout(() => {
          const chip = document.createElement('button'); chip.type = 'button'; chip.setAttribute('aria-label', 'Remover anexo de texto colado');
          chip.onclick = () => chip.remove(); document.getElementById('chips').append(chip);
        }, 200);
      });}</script>`);
    assert.equal(await fillChatGPTEditor(page.locator('#editor'), prompt), 'fill');
    assert.equal(await page.locator('#chips button').count(), 0, 'the prompt must not be sent twice');
    assert.equal((await page.locator('#editor').innerText()).replace(/\s+/g, ''), prompt.replace(/\s+/g, ''));

    // A partial paste plus a stray file: remove the file and type the whole prompt instead.
    await page.setContent(`<form><div id="chips"></div><div id="editor" contenteditable="true"></div></form><script>{
      const editor = document.getElementById('editor');
      editor.addEventListener('paste', event => {
        event.preventDefault(); editor.textContent = 'parte';
        const chip = document.createElement('button'); chip.type = 'button'; chip.setAttribute('aria-label', 'Remove pasted text');
        chip.onclick = () => chip.remove(); document.getElementById('chips').append(chip);
      });}</script>`);
    assert.equal(await fillChatGPTEditor(page.locator('#editor'), prompt), 'fill');
    assert.equal(await page.locator('#chips button').count(), 0);
    assert.equal((await page.locator('#editor').innerText()).replace(/\s+/g, ''), prompt.replace(/\s+/g, ''));
  } finally { await browser.close(); }
});

test('ChatGPT capture correlates the Markdown-escaped text the composer submits', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://chatgpt.com/**', route => new URL(route.request().url()).pathname.startsWith('/backend-api/') ?
      route.fulfill({ contentType: 'text/event-stream', body: 'data: [DONE]\n\n' }) : route.fulfill({ contentType: 'text/html', body: '<p>Chat</p>' }));
    await page.addInitScript(installChatGPTCapture);
    await page.goto('https://chatgpt.com/');
    const send = (capture: Record<string, unknown>, message: unknown) => page.evaluate(async ({ capture, message }) => {
      (globalThis as any).__proxyChatGPT = { model: 'auto', chunks: [], bytes: 0, claimed: false, done: false, ...capture };
      await (await fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ model: 'auto', messages: [message] }) })).text();
      return (globalThis as any).__proxyChatGPT.claimed as boolean;
    }, { capture, message });
    const prompt = '## Communication\n- Default to a concise tone.\n* use `code`_names_';
    const escaped = '\\## Communication\n\\- Default to a concise tone.\n\\* use \\`code\\`\\_names\\_';
    assert.equal(await send({ prompt }, { author: { role: 'user' }, content: { parts: [escaped] } }), true);
    assert.equal(await send({ prompt }, { author: { role: 'user' }, content: { parts: ['Another prompt'] } }), false);
    const linked = 'Image syntax: `![alt](https://example.com/a.png)` keeps working in the IDE agent.';
    assert.equal(await send({ prompt: linked }, { author: { role: 'user' },
      content: { parts: ['Image syntax: `!\\[alt\\]([https://example.com/a.png](https://example.com/a.png))` keeps working in the IDE agent.'] } }), true);
    assert.equal(await send({ prompt: linked }, { author: { role: 'user' },
      content: { parts: ['Image syntax: `![alt](https://example.com/a.png)` keeps working in the agent.'] } }), false, 'a missing word is another prompt');
    assert.equal(await send({ prompt: 'ok' }, { author: { role: 'user' }, content: { parts: ['\\ok'] } }), false, 'short prompts need an exact match');
    assert.equal(await send({ prompt }, { author: { role: 'user' }, content: { parts: [''] },
      metadata: { attachments: [{ name: 'Texto colado.txt', mime_type: 'text/plain', size: prompt.length }] } }), false, 'a pasted-text file is not the prompt message');
  } finally { await browser.close(); }
});
