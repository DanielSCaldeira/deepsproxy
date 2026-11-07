import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { mistralError, mistralModels, parseMistralStream } from './providers/mistral-protocol.ts';
import { inspectMistralPage, installMistralCapture } from './providers/mistral-browser.ts';
import { isProviderId, providerId, providerIdForModel } from './providers/catalog.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { MistralProvider, withMistralOutputRules } from './providers/mistral.ts';
// The fixture reads the editor's innerText, which renders paragraph breaks as blank lines.
const lines = (text: string) => text.replace(/\n+/g, '\n');
import { getProvider } from './providers/registry.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

// Stream framing read from the site's public bundles: `<code>:<payload>` lines;
// code 15 carries superjson state updates with message patches; 8 is done.
const line = (value: unknown, code = '15') => `${code}:${JSON.stringify(code === '15' ? { json: value } : value)}\n`;
const patch = (patches: unknown[], id = 'm1') => line({ type: 'message', messageId: id, messageVersion: 0, patches });
const replace = (text: string, id = 'm1', role = 'assistant') => patch([{ op: 'replace', path: '/', value: { id, role, contentChunks: [{ type: 'text', text }] } }], id);
const append = (text: string, id = 'm1', index = 0) => patch([{ op: 'append', path: `/contentChunks/${index}/text`, value: text }], id);
const done = '8:null\n';
async function* chunks(text: string, size = 1) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };
const content = (values: any[]) => values.filter(v => v.type === 'content').map(v => v.text).join('');

test('Mistral catalog and routing advertise only observed modes', () => {
  assert.equal(isProviderId('mistral'), true); assert.equal(providerId('mistral'), 'mistral');
  assert.equal(providerIdForModel('mistral/fast'), 'mistral'); assert.equal(providerIdForModel('mistral-large-latest'), null);
  // Menu items concatenate title and description in textContent.
  assert.deepEqual(mistralModels(['FastGet answers fast', 'ThinkHandle complex tasks']),
    [{ id: 'mistral/fast', contextLength: 0 }, { id: 'mistral/think', contextLength: 0 }]);
  assert.deepEqual(mistralModels([], 'Fast'), [{ id: 'mistral/fast', contextLength: 0 }]);
  assert.deepEqual(mistralModels(['Faster', 'Settings', 'Thinker']), []);
  const args = interactiveWorkerArguments('/profile', 'https://chat.mistral.ai/chat');
  assert.equal(args.at(-1), 'https://chat.mistral.ai/chat'); assert.ok(!args.some(a => a.includes('remote-debugging')));
  assert.equal(mistralError(403).status, 403); assert.doesNotMatch(mistralError(403).message, /suspended|login/);
  assert.match(mistralError(403, 'account_suspended').message, /account is suspended/);
  assert.equal(mistralError(502, 'rate_limit_exceeded').status, 429);
  assert.equal(mistralError(401).status, 401);
});

test('Mistral opens the collapsed /work composer after hydration replaces its placeholder', async () => {
  const browser = await chromium.launch(), provider = new MistralProvider();
  try {
    const context = await browser.newContext(), page = await context.newPage();
    Object.assign(provider,{context,page});
    await page.route('https://chat.mistral.ai/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`
      <div class="_chat-input-bar_fixture"><span>Digite / para acesso rápido</span></div>
      <script>let clicks=0;const bar=document.querySelector('div');
        bar.onclick=()=>{clicks++;window.clicks=clicks;if(clicks===1){bar.innerHTML='<span>Digite / para acesso rápido</span>';return;}
          bar.innerHTML='<div class="rich-text-editor ProseMirror" contenteditable="true" style="min-height:24px"> </div>';};
        history.replaceState(null,'','/work');
      </script>`}));
    await (provider as any).navigate();
    assert.equal(await page.locator('.rich-text-editor[contenteditable=true]').isVisible(),true);
    assert.equal(await page.evaluate(()=>(window as any).clicks),2);
  } finally {await provider.close();await browser.close();}
});

test('Mistral stream parts: assistant patches only, split Unicode, CRLF, formatting and hidden chunks', async () => {
  const stream = (replace('Leia o arquivo', 'u1', 'user') + '0:"ignorado"\n' + replace('Olá') + append(' Olá\n```ts\nx()\n```') +
    patch([{ op: 'add', path: '/contentChunks/-', value: { type: 'thinking', text: 'privado' } }]) +
    patch([{ op: 'append', path: '/contentChunks/0/text', value: '!' }]).replace(/\n$/, '__context__:{"json":{}}\n') +
    '99:{"future":true}\n' + done).replace(/\n/g, '\r\n');
  const values = await collect(parseMistralStream(chunks(stream, 3)));
  assert.equal(content(values), 'Olá Olá\n```ts\nx()\n```!');
  assert.deepEqual(values.at(-1), { type: 'finish' });
  assert.doesNotMatch(content(values), /privado|ignorado|Leia/);
  // Single-character chunks split surrogate pairs and line framing.
  assert.equal(content(await collect(parseMistralStream(chunks(replace('ção 🙂') + done)))), 'ção 🙂');
});

test('Mistral ignores the aggregate content while typed answer chunks initialize', async () => {
  const stream = patch([{op:'replace',path:'/',value:{id:'m1',role:'assistant',content:'PRIVATE_THINKING'}}]) +
    patch([{op:'replace',path:'/contentChunks',value:[{type:'thinking',text:'PRIVATE_THINKING'},{type:'text',text:'ANSWER_OK'}]}]) + done;
  assert.equal(content(await collect(parseMistralStream(chunks(stream,3)))),'ANSWER_OK');
});

test('Mistral bootstrap seeds messages; patches follow RFC 6902 and the body end completes', async () => {
  const bootstrap = line({ type: 'bootstrap', chat: { id: 'c1' }, canvas: [],
    messages: [{ id: 'u1', version: 0, role: 'user', contentChunks: [{ type: 'text', text: 'pergunta' }] },
      { id: 'm1', version: 0, role: 'assistant', contentChunks: [{ type: 'text', text: '' }] }] });
  const stream = bootstrap + append('Um') + patch([{ op: 'test', path: '/role', value: 'assistant' }, { op: 'append', path: '/contentChunks/0/text', value: ' dois' }]) +
    patch([{ op: 'append', path: '/missing', value: 'x' }]) + line({ type: 'chat', patches: [] });
  assert.equal(content(await collect(parseMistralStream(chunks(stream, 5)))), 'Um dois');
});

test('Mistral decoding fails explicitly on errors, revisions, unsafe paths and empty answers', async () => {
  for (const input of ['15:not-json\n', replace('abc') + replace('ab'), '', done, patch([]) + done, '<html>Just a moment</html>\n',
    patch([{ op: 'add', path: '/__proto__/polluted', value: true }]), patch([{ op: 'bogus', path: '/x', value: 1 }]),
    replace('parcial') + '6:{"code":"internal_error"}\n']) {
    await assert.rejects(() => collect(parseMistralStream(chunks(input))), UpstreamError);
  }
  assert.equal(({} as any).polluted, undefined);
  await assert.rejects(() => collect(parseMistralStream(chunks('6:{"code":"CHAT_REQUEST_RATE_LIMITED"}\n'))), (e: any) => e.status === 429);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(parseMistralStream(chunks(replace('text')), controller.signal)));
});

test('Mistral decoded tool calls use the shared OpenAI parser', async () => {
  const text = '<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
  const parsed = await parseProviderStreamToOpenAI(parseMistralStream(chunks(replace(text) + done, 7)),
    'chatcmpl-fixture', 'mistral/fast', 10, [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });
});

test('Mistral page inspection separates visitor, signed-in, terms dialog and browser verification', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const html: Record<string, string> = {
      '/visitor': `<script>self.__next_f=[[1,'{"session":null,"anonymousUser":{"id":"x"}}']]</script>
        <button>Sign in</button><button>Sign up</button>${composer()}
        <div role="dialog"><h2>Vibe Terms of Service</h2><button>Accept and continue</button></div>`,
      '/member': `<script>self.__next_f=[[1,'{"session":{"user":{}}}']]</script>${composer()}
        <div role="dialog"><h2>Vibe Terms of Service</h2><button>Accept and continue</button></div>`,
      '/quota': `${composer()}<p>You have reached the quota for your current plan.</p>`,
    };
    await page.route('https://chat.mistral.ai/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/challenge') return route.fulfill({ status: 403, contentType: 'text/html', body: '<title>Just a moment...</title><div id="challenge-stage"></div>' });
      return route.fulfill({ contentType: 'text/html', body: html[pathname] ?? '' });
    });
    const inspect = async (pathname: string) => { await page.goto('https://chat.mistral.ai' + pathname); return page.evaluate(inspectMistralPage); };
    assert.deepEqual(await inspect('/visitor'), { challenge: false, anonymous: true, signIn: true, composer: true, terms: true, limit: null });
    assert.deepEqual(await inspect('/member'), { challenge: false, anonymous: false, signIn: false, composer: true, terms: true, limit: null });
    assert.equal((await inspect('/challenge')).challenge, true);
    assert.equal((await inspect('/quota')).limit, 'quota');
  } finally { await browser.close(); }
});

test('Mistral browser capture ignores telemetry and JSON mutations, follows the chat stream and cancels it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://chat.mistral.ai/', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('https://chat.mistral.ai/');
    await page.evaluate(() => {
      (globalThis as any).originalCalls = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input); (globalThis as any).originalCalls.push(url);
        if (url.includes('/api/trpc/')) return new Response('[{"result":{"data":{"json":{"chatId":"c1"}}}}]', { headers: { 'content-type': 'application/json' } });
        const body = new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode('15:{"json":{"patches":[]}}\n'));
          init?.signal?.addEventListener('abort', () => { (globalThis as any).aborted = true; c.error(new Error('aborted')); });
        } });
        return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      };
    });
    await page.evaluate(installMistralCapture);
    const result = await page.evaluate(async () => {
      const scope = globalThis as any;
      scope.__proxyMistral = { prompt: 'hello  world', chunks: [], bytes: 0, claimed: false, promptSeen: false, done: false };
      const calls = ([['/api/trpc/event.sendEventToDatalake', { text: 'hello world' }], ['/api/chat', { chatId: 'other' }],
        ['/api/trpc/message.newChat?batch=1', { 0: { json: { content: [{ type: 'text', text: 'hello world' }] } } }], ['/api/chat', { chatId: 'c1', mode: 'start' }]] as Array<[string, unknown]>)
        .map(([url, body]) => [url, { method: 'POST', body: JSON.stringify(body) }]) as Array<[string, RequestInit]>;
      await fetch(...calls[0]);
      const afterTelemetry = scope.__proxyMistral.promptSeen;
      await fetch(...calls[1]);
      const beforePrompt = scope.__proxyMistral.claimed;
      await fetch(...calls[2]);
      const afterMutation = { seen: scope.__proxyMistral.promptSeen, claimed: scope.__proxyMistral.claimed };
      const response = await fetch(...calls[3]);
      const reader = response.body!.getReader(); const first = await reader.read();
      await new Promise(r => setTimeout(r, 10));
      scope.__proxyMistral.controller.abort();
      await new Promise(r => setTimeout(r, 10));
      return { afterTelemetry, beforePrompt, afterMutation, first: new TextDecoder().decode(first.value),
        captured: scope.__proxyMistral.chunks.join(''), claimed: scope.__proxyMistral.claimed, aborted: scope.aborted, calls: scope.originalCalls.length };
    });
    assert.equal(result.afterTelemetry, false); assert.equal(result.beforePrompt, false);
    assert.deepEqual(result.afterMutation, { seen: true, claimed: false });
    assert.equal(result.first, '15:{"json":{"patches":[]}}\n'); assert.equal(result.captured, result.first);
    assert.equal(result.claimed, true); assert.equal(result.aborted, true); assert.equal(result.calls, 4);
  } finally { await browser.close(); }
});

function composer(sendButton = true) {
  return `<form id="composer"><button type="submit" hidden></button>
    <div data-composer-editor="true"><div class="ProseMirror" contenteditable="true" data-placeholder="Ask anything"><p><br></p></div></div>
    <button type="button" id="mode" aria-label="Selecionar modelo" aria-haspopup="menu"><svg></svg><span>Fast</span><svg></svg></button>
    <button type="button" aria-label="Voice Mode"></button>
    ${sendButton ? '<button type="submit" id="send" aria-label="Send" hidden></button>' : ''}
    <div id="menu" role="menu" hidden><div role="menuitemradio" data-mode="Fast">Fast<span>Get answers fast</span></div><div role="menuitemradio" data-mode="Think">Think<span>Handle complex tasks</span></div></div>
  </form>`;
}
const composerScript = `<script>
  const form=document.getElementById('composer'), editor=form.querySelector('[contenteditable]'), send=document.getElementById('send'), mode=document.getElementById('mode'), menu=document.getElementById('menu');
  editor.addEventListener('input',()=>{ if(send) send.hidden=!editor.innerText.trim(); });
  editor.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); form.requestSubmit(); } });
  mode.onclick=()=>{ menu.hidden=!menu.hidden; };
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') menu.hidden=true; });
  for (const item of menu.children) item.onclick=()=>{ mode.querySelector('span').textContent=item.dataset.mode; menu.hidden=true; };
  form.onsubmit=async e=>{ e.preventDefault(); const prompt=editor.innerText;
    const response=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({mode:'create',model:mode.textContent.trim().toLowerCase(),messageInput:[{type:'text',text:prompt}],clientPromptData:{currentDate:'2026-11-06'}})});
    history.pushState(null,'','/chat/fixture-chat'); await response.text(); };
</script>`;

test('Mistral frontend fixture: signed-in account, modes, generation, tools, quota, expiry and guard release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mistral-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'mistral';
  const browser = await chromium.launch();
  const provider = getProvider() as MistralProvider;
  try {
    const context = await browser.newContext();
    await context.addInitScript(installMistralCapture);
    const page = await context.newPage();
    let anonymous = false, quota = false, sendButton = true;
    const prompts: Array<{ text: string; mode: string }> = [];
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard });
    await page.route('https://chat.mistral.ai/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/chat') {
        const body = route.request().postDataJSON();
        prompts.push({ text: body.messageInput[0].text, mode: body.model });
      }
      if (pathname === '/api/chat') return route.fulfill(quota ?
        { status: 429, headers: { 'retry-after': '120' }, json: { code: 'CHAT_REQUEST_RATE_LIMITED', detail: 'fixture' } } :
        { contentType: 'text/plain; charset=utf-8', body: replace('Leia', 'u1', 'user') + replace('Olá') + append(' do fixture') + done });
      return route.fulfill({ contentType: 'text/html', body: `<script>self.__next_f=[[1,'{"session":${anonymous ? 'null' : '{"user":{}}'}}']]</script>
        <header>${anonymous ? '<button type="button">Sign in</button><button type="button">Sign up</button>' : '<button type="button" aria-label="Open settings menu"></button>'}</header>
        ${composer(sendButton)}${composerScript}` });
    });
    await page.goto('https://chat.mistral.ai/chat');
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).authenticated, true);
    assert.deepEqual(await provider.models(), [{ id: 'mistral/fast', contextLength: 0 }, { id: 'mistral/think', contextLength: 0 }]);
    const result = await collect(await provider.generate('Teste', 'mistral/fast', false));
    assert.equal(content(result), 'Olá do fixture'); assert.equal(guard.status().busy, false);
    assert.deepEqual({ ...prompts.at(-1), text: lines(prompts.at(-1)!.text) }, { text: lines(withMistralOutputRules('Teste')), mode: 'fast' });
    assert.equal(content(await collect(await provider.generate('Pense nisto', 'mistral/think', false))), 'Olá do fixture');
    assert.deepEqual({ ...prompts.at(-1), text: lines(prompts.at(-1)!.text) }, { text: lines(withMistralOutputRules('Pense nisto')), mode: 'think' });
    await assert.rejects(() => provider.generate('x', 'mistral/unknown', false), (e: any) => e.status === 400);
    sendButton = false; // Without a visible send control, Enter submits as a person would.
    assert.equal(content(await collect(await provider.generate('Enviar com Enter', 'mistral/fast', false))), 'Olá do fixture');
    assert.equal(lines(prompts.at(-1)!.text), lines(withMistralOutputRules('Enviar com Enter'))); sendButton = true;
    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const models = await (await app.request('/v1/models', { headers })).json();
    assert.deepEqual(models.data.map((m: any) => m.id), ['mistral/fast', 'mistral/think']);
    assert.equal(models.data[0].context_limit_source, 'unknown'); assert.equal(models.data[0].max_output_tokens, undefined);
    const effort = await app.request('/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: 'mistral/fast', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(effort.status, 400);
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'mistral/fast', stream,
          tools: [{type:'function',function:{name:'lookup',description:'Read the requested information.',parameters:{type:'object',properties:{},additionalProperties:false}}}],
          messages: [
          { role: 'system', content: 'IDE rules: preserve files and use the supplied tools.' },
          { role: 'user', content: 'Primeiro turno' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call-fixture', content: 'Resultado da ferramenta' },
          { role: 'user', content: 'Continue' },
        ] }) });
      assert.equal(response.status, 200);
      const text = await response.text();
      const answer = stream ? text.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)).choices[0]?.delta?.content ?? '').join('') : JSON.parse(text).choices[0].message.content;
      assert.equal(answer, 'Olá do fixture'); if (stream) assert.match(text, /data: \[DONE\]/);
      const sent = prompts.at(-1)!.text;
      assert.match(sent, /IDE rules: preserve files and use the supplied tools\./);
      assert.match(sent, /Tools:.*"name":"lookup"/s);
      assert.match(sent, /<tool_call>/);
      assert.match(sent, /User: Primeiro turno/);
      assert.match(sent, /Tool Response \(call-fixture\): Resultado da ferramenta/);
    }
    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'mistral/fast', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 50 && guard.status().busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.status().busy, false);
    // Disable fixture cooldown without sleeping; production still uses the normal guard.
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    quota = true;
    await assert.rejects(async () => collect(await provider.generate('Teste', 'mistral/fast', false)), (e: any) => e.status === 429);
    assert.equal((await provider.status()).state, 'rate_limited');
    assert.equal((await provider.status()).authenticated, true, 'a usage limit does not expire the login');
    assert.ok(Date.parse(guard.status().nextAllowedAt!) >= Date.now() + 119000);
    assert.equal(guard.status().busy, false);
    anonymous = true;
    await page.goto('https://chat.mistral.ai/chat');
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    const error = apiError(new UpstreamError('Mistral login is required.', 401), 'mistral_login_required').error;
    assert.equal(error.help_url, 'https://chat.mistral.ai/chat'); assert.match(error.user_action, /Concluir login/);
    assert.match(error.user_action, /card do Mistral/); assert.doesNotMatch(error.user_action, /DeepSeek/);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Mistral early manual confirmation reopens login; a visitor session is not accepted; success saves the profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mistral-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new MistralProvider();
  let signedIn = false, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      // Visitors also get a working composer; only the session decides.
      await page.route('https://chat.mistral.ai/**', route => route.fulfill({ contentType: 'text/html',
        body: `<script>self.__next_f=[[1,'{"session":${signedIn ? '{"user":{}}' : 'null'}}']]</script>${signedIn ? '' : '<button>Sign in</button>'}${composer()}` }));
      await page.goto('https://chat.mistral.ai/chat');
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    await assert.rejects(() => provider.finishLogin(), /Conclua o acesso/);
    assert.equal(reopened, 1); assert.equal((await provider.status()).confirmationRequired, true);
    signedIn = true;
    await provider.finishLogin();
    const status = await provider.status();
    assert.equal(status.state, 'authenticated'); assert.equal(status.sessionSaved, true); assert.equal(status.authenticated, true);
    assert.equal(humanRunning, false);
    const page = provider.getActivePage(); await provider.initialize(false); assert.equal(provider.getActivePage(), page);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Mistral prompt ends with explicit output rules; tool rules only when tools are offered', () => {
  const plain = withMistralOutputRules('User: Responda apenas: TESTE_PROXY_OK\n\n');
  assert.ok(plain.startsWith('User: Responda apenas: TESTE_PROXY_OK\n\nOUTPUT RULES (mandatory):'));
  assert.match(plain, /never write sentences like "The user wants\.\.\."/);
  assert.doesNotMatch(plain, /<tool_call>/);
  assert.doesNotMatch(plain, /^- /m, 'the rich-text editor would turn dashes into a list');
  const tools = withMistralOutputRules('Tools: []\nTo call a listed tool, output <tool_call>{}</tool_call>\n\nUser: ler');
  const tail = tools.split('OUTPUT RULES')[1];
  assert.match(tail, /output only the tool call blocks in the format given above/);
  assert.doesNotMatch(tail, /<tool_call>/, 'a second tool template made the site answer HTTP 500');
});
