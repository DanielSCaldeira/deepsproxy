import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { ERNIE_INPUT_LIMIT, ernieError, ernieLoginFromHtml, ernieModels, parseErnieStream } from './providers/ernie-protocol.ts';
import { installErnieCapture } from './providers/ernie-browser.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { ErnieProvider } from './providers/ernie.ts';
import { getProvider } from './providers/registry.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

// Frames mirror the structure captured from wenxin.baidu.com on 2026-11-06 (ids and logs synthetic).
const frame = (event: string, value: unknown) => `event:${event}\ndata:${JSON.stringify(value)}\n\n`;
const basedata = (login: unknown = true) => frame('basedata', { status: 0, user: { isUserLogin: login, userInfo: { uid: false } }, query: 'q', lid: '1' });
const packet = (state: string, generator?: unknown, extra: any = {}) => frame('message', { status: 0, qid: '1', sessionId: '1', seq_id: 0,
  data: { message: { msgId: 'm', metaData: { state, endTurn: false, ...extra.meta }, content: generator ? { generator, cacheStatus: 0 } : { cacheStatus: 0 } } }, ...extra.root });
const markdown = (value: string) => packet('generating-resp', { component: 'markdown-yiyan', isSafe: 1, isFinished: false, data: { value } });
const thinking = (parts: string[], noReasoning = false) => packet('generating-resp', { component: 'thinkingSteps', data: { reasoningContentArr: parts, noReasoning } });
const followUp = packet('generating-resp', { component: 'questionClosely', data: { list: ['Pergunta sugerida'] } });
const answerDone = packet('generate-complete', { isFinished: true });
const endTurn = packet('generate-complete', undefined, { meta: { endTurn: true } });
const answer = (...values: string[]) => basedata() + 'event:ping\n\n' + packet('waiting-resp') + thinking([''], true) +
  values.map(markdown).join('') + answerDone + followUp + endTurn;
async function* chunks(text: string, size = 1) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };

test('Ernie catalog, routing, login detection and error mapping', () => {
  assert.equal(providerId('ernie'), 'ernie'); assert.equal(providerIdForModel('ernie/smartMode'), 'ernie');
  assert.equal(providerIdForModel('ernie-unknown'), null);
  assert.deepEqual(ernieModels([{ name: 'smartMode', label: '自动' }, { name: 'ERINE-5.1', label: ' 文心 5.1 ' },
    { name: 'smartMode', label: 'dup' }, { name: 'bad"name', label: 'x' }, { name: null, label: 'none' }]),
  [{ id: 'ernie/smartMode', label: '自动', contextLength: 0 }, { id: 'ernie/ERINE-5.1', label: '文心 5.1', contextLength: 0 }]);
  const html = (login: unknown) => `<script type="application/json" name="aiTabFrameBaseData">{"token":"t","userInfo":{"name":"","isUserLogin":${JSON.stringify(login)}}}</script>`;
  assert.equal(ernieLoginFromHtml(html(0)), false); assert.equal(ernieLoginFromHtml(html(1)), true);
  assert.equal(ernieLoginFromHtml(html(true)), true); assert.equal(ernieLoginFromHtml('<html>百度安全验证</html>'), null);
  const args = interactiveWorkerArguments('/profile', 'https://wenxin.baidu.com/');
  assert.equal(args.at(-1), 'https://wenxin.baidu.com/'); assert.ok(!args.some(a => a.includes('remote-debugging')));
  assert.equal(ernieError(401).status, 401); assert.equal(ernieError(429).status, 429);
  assert.equal(ernieError(503, 'security_verification').status, 503); assert.doesNotMatch(ernieError(403).message, /login/);
});

test('Ernie SSE appends answer deltas, ignores follow-ups and survives CRLF and split Unicode', async () => {
  const input = answer('收到', '，Olá', ' Olá\n```ts\nx()\n```').replace(/\n/g, '\r\n');
  const values = await collect(parseErnieStream(chunks(input)));
  assert.equal(values.filter(v => v.type === 'content').map(v => v.text).join(''), '收到，Olá Olá\n```ts\nx()\n```');
  assert.equal(values.filter(v => v.type === 'reasoning').length, 0, 'noReasoning steps are not exposed');
  assert.deepEqual(values.at(-1), { type: 'finish' });
  assert.equal(values.filter(v => v.type === 'finish').length, 1);
  // Repeated equal deltas are real text, never de-duplicated.
  const repeated = await collect(parseErnieStream(chunks(answer('ha', 'ha'), 7)));
  assert.equal(repeated.filter(v => v.type === 'content').map(v => v.text).join(''), 'haha');
  const reasoning = await collect(parseErnieStream(chunks(basedata() + thinking(['pensa']) + thinking(['pensando']) + markdown('ok') + endTurn, 5)));
  assert.deepEqual(reasoning, [{ type: 'reasoning', text: 'pensa' }, { type: 'reasoning', text: 'ndo' }, { type: 'content', text: 'ok' }, { type: 'finish' }]);
});

test('Ernie decoding fails explicitly on expiry, risk hints, unsupported flows and truncation', async () => {
  // Captured shape of the guest risk-control answer ("抱歉，出了点小问题").
  const riskHint = basedata() + frame('message', { status: 1005, data: { message: { metaData: { state: 'generate-complete', endTurn: false },
    content: { generator: { isFinished: true }, hints: { parts: [{ type: 'kunlunHint', text: '抱歉，出了点小问题，请稍后重试' }] } } } } }) + endTurn;
  for (const input of [riskHint, basedata() + frame('reconnect', { qid: '1' }), 'event:message\ndata:nope\n\n',
    basedata() + markdown('unfinished'), basedata() + endTurn, basedata() + frame('message', { status: 1004 })]) {
    await assert.rejects(() => collect(parseErnieStream(chunks(input))), UpstreamError);
  }
  await assert.rejects(() => collect(parseErnieStream(chunks(answer('x').replace(basedata(), basedata(false))))), (e: any) => e.status === 401);
  await assert.rejects(() => collect(parseErnieStream(chunks(answer('x').replace(basedata(), basedata(0))))), (e: any) => e.status === 401);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(parseErnieStream(chunks(answer('x')), controller.signal)));
});

test('Ernie decoded tool calls use the shared OpenAI parser', async () => {
  const text = '<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
  const parsed = await parseProviderStreamToOpenAI(parseErnieStream(chunks(answer(text.slice(0, 20), text.slice(20)), 9)),
    'chatcmpl-fixture', 'ernie/smartMode', 10, [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });
});

test('Ernie browser capture ignores other requests and prompts, enforces model and cancels the real request', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://wenxin.baidu.com/', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('https://wenxin.baidu.com/');
    await page.evaluate(() => {
      (globalThis as any).originalCalls = [];
      globalThis.fetch = async (input, init) => {
        (globalThis as any).originalCalls.push(String(input));
        const body = new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode('event:ping\n\n'));
          init?.signal?.addEventListener('abort', () => { (globalThis as any).aborted = true; c.error(new Error('aborted')); });
        } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream;charset=UTF-8' } });
      };
    });
    await page.evaluate(installErnieCapture);
    // Request bodies are built in Node: helper functions inside evaluate would need tsx's __name.
    const request = (prompt: string) => ({ method: 'POST', body: JSON.stringify({ message: {
      query: [{ type: 'TEXT', data: { text: { query: prompt } } }], searchInfo: { usedModel: { modelName: 'smartMode' } } } }) });
    const result = await page.evaluate(async ({ matching, other }) => {
      const scope = globalThis as any;
      scope.__proxyErnie = { prompt: 'olá  mundo', model: 'smartMode', chunks: [], bytes: 0, done: false };
      await fetch('https://chat.baidu.com/aichat/api/riskcheck', matching);
      await fetch('https://chat.baidu.com/aichat/api/conversation', other);
      const afterOthers = !!scope.__proxyErnie.claimed;
      const response = await fetch('https://chat.baidu.com/aichat/api/conversation', matching);
      const reader = response.body!.getReader(); const first = await reader.read();
      await new Promise(r => setTimeout(r, 10));
      scope.__proxyErnie.controller.abort();
      await new Promise(r => setTimeout(r, 10));
      const captured = scope.__proxyErnie.chunks.join('');
      scope.__proxyErnie = { prompt: 'olá mundo', model: 'ERINE-5.1', chunks: [], bytes: 0, done: false };
      try { await fetch('https://chat.baidu.com/aichat/api/conversation', matching); } catch { /* expected mismatch */ }
      return { afterOthers, first: new TextDecoder().decode(first.value), captured, aborted: scope.aborted,
        mismatch: scope.__proxyErnie.error, calls: scope.originalCalls.length };
    }, { matching: request('olá mundo'), other: request('outro prompt') });
    assert.equal(result.afterOthers, false); assert.equal(result.first, 'event:ping\n\n');
    assert.equal(result.aborted, true); assert.equal(result.mismatch, 'model_mismatch'); assert.equal(result.calls, 3);
    assert.equal(result.captured, 'event:ping\n\n');
  } finally { await browser.close(); }
});

// Minimal composer reproducing the observed hooks: #chat-textarea, .ci-submit-button,
// data-testid mode selector and the role=menu "选择模型" cascade with data-model-name.
const composer = (login: number) => `<!doctype html><meta charset="utf-8">
<script type="application/json" name="aiTabFrameBaseData">{"token":"fixture","userInfo":{"name":"","isUserLogin":${login}}}</script>
<div class="chat-aside-user-mask ${login ? '' : 'unlogin'}">${login ? 'fixture' : '请登录'}</div>
<div id="ci-main"><textarea id="chat-textarea" class="ci-textarea" maxlength="20000" placeholder="帮我"></textarea>
<button type="button" class="ci-input-mode-button" data-testid="chat-mode-selector" aria-haspopup="menu">对话</button>
<div class="ci-input-mode-panel" role="menu" aria-label="选择回答模式" hidden>
  <button type="button" role="menuitemradio" aria-checked="true" data-chat-mode="fast">对话</button>
  <button type="button" role="menuitemradio" aria-checked="false" data-chat-mode="task">工作任务</button>
  <div data-testid="chat-mode-model-row">模型 自动</div>
  <div class="ci-input-mode-cascade-panel" role="menu" aria-label="选择模型" hidden>
    <button type="button" role="menuitemradio" aria-checked="true" data-model-name="smartMode">自动</button>
    <button type="button" role="menuitemradio" aria-checked="false" data-model-name="ERINE-5.1">文心 5.1</button>
  </div>
</div>
<span class="ci-submit-button" style="display:inline-block;width:20px;height:20px"><img id="ci-submit-button-ai" alt=""></span></div>
<script>
const $ = s => document.querySelector(s); let model = 'smartMode';
$('[data-testid="chat-mode-selector"]').onclick = () => { $('.ci-input-mode-panel').hidden = !$('.ci-input-mode-panel').hidden; };
$('[data-testid="chat-mode-model-row"]').onclick = () => { $('.ci-input-mode-cascade-panel').hidden = !$('.ci-input-mode-cascade-panel').hidden; };
for (const item of document.querySelectorAll('[data-model-name]')) item.onclick = () => {
  for (const other of document.querySelectorAll('[data-model-name]')) other.setAttribute('aria-checked', String(other === item));
  model = item.dataset.modelName;
};
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('.ci-input-mode-panel').hidden = true; $('.ci-input-mode-cascade-panel').hidden = true; } });
$('.ci-submit-button').onclick = async () => {
  const query = $('#chat-textarea').value;
  history.pushState(null, '', '/search/1?enter_type=chat_url');
  const response = await fetch('https://chat.baidu.com/aichat/api/conversation', { method: 'POST', body: JSON.stringify({ message: {
    query: [{ type: 'TEXT', data: { text: { query, extData: '{}' } } }], searchInfo: { usedModel: { modelName: model, showModelName: model } } } }) });
  await response.text();
};
</script>`;

async function fixtureProvider(page: Page, state: { login: number; reply: () => string; prompts: Array<{ query: string; model: string }> }) {
  await page.route('https://wenxin.baidu.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composer(state.login) }));
  await page.route('https://chat.baidu.com/**', route => {
    const body = route.request().postDataJSON();
    state.prompts.push({ query: body.message.query[0].data.text.query, model: body.message.searchInfo.usedModel.modelName });
    return route.fulfill({ headers: { 'content-type': 'text/event-stream;charset=UTF-8', 'access-control-allow-origin': 'https://wenxin.baidu.com' }, body: state.reply() });
  });
  await page.goto('https://wenxin.baidu.com/');
}

test('Ernie frontend fixture: login, model menu, generation, tools, cancellation and expiry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ernie-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'ernie';
  const browser = await chromium.launch();
  const provider = getProvider() as ErnieProvider;
  try {
    const context = await browser.newContext({ locale: 'zh-CN' });
    await context.addInitScript(installErnieCapture);
    const page = await context.newPage();
    const state = { login: 1, reply: () => answer('你好', ' do fixture'), prompts: [] as Array<{ query: string; model: string }> };
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard });
    await fixtureProvider(page, state);
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).authenticated, true);
    assert.deepEqual(await provider.models(), [{ id: 'ernie/smartMode', contextLength: 0 }, { id: 'ernie/ERINE-5.1', contextLength: 0 }]);
    assert.equal(await page.locator('.ci-input-mode-panel').isHidden(), true, 'the model menu is closed after reading it');
    const result = await collect(await provider.generate('Teste\n\n  com espaços', 'ernie/smartMode', false));
    assert.equal(result.filter(v => v.type === 'content').map(v => v.text).join(''), '你好 do fixture');
    assert.deepEqual(state.prompts.at(-1), { query: 'Teste\n\n  com espaços', model: 'smartMode' });
    assert.equal(guard.status().busy, false);
    await collect(await provider.generate('Modelo explícito', 'ernie/ERINE-5.1', false));
    assert.deepEqual(state.prompts.at(-1), { query: 'Modelo explícito', model: 'ERINE-5.1' });
    await assert.rejects(() => provider.generate('x', 'ernie/missing-model', false), (e: any) => e.status === 400);
    const before = state.prompts.length;
    await assert.rejects(() => provider.generate('x'.repeat(ERNIE_INPUT_LIMIT + 1), 'ernie/smartMode', false), (e: any) => e.status === 413);
    assert.equal(state.prompts.length, before, 'oversized prompts never reach the site');
    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const models = await (await app.request('/v1/models', { headers })).json();
    assert.deepEqual(models.data.map((m: any) => m.id), ['ernie/smartMode', 'ernie/ERINE-5.1']);
    assert.equal(models.data[0].context_limit_source, 'unknown'); assert.equal(models.data[0].max_output_tokens, undefined);
    state.reply = () => answer('<tool_call>{"name":"lookup","arguments":{}}</tool_call>');
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'ernie/smartMode', stream,
          tools: [{ type: 'function', function: { name: 'lookup', description: 'Read the requested information.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
          messages: [
            { role: 'system', content: 'IDE rules: preserve files and use the supplied tools.' },
            { role: 'user', content: 'Primeiro turno' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call-fixture', content: 'Resultado da ferramenta' },
            { role: 'user', content: 'Continue' },
          ] }) });
      assert.equal(response.status, 200); assert.match(await response.text(), /lookup/);
      const prompt = state.prompts.at(-1)!.query;
      assert.match(prompt, /^IDE rules: preserve files and use the supplied tools\./);
      assert.match(prompt, /Tools:.*"name":"lookup"/);
      assert.match(prompt, /To call a listed tool, output <tool_call>/);
      assert.match(prompt, /Tool Response \(call-fixture\): Resultado da ferramenta/);
    }
    const rejected = await app.request('/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: 'ernie/smartMode', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(rejected.status, 400);
    state.reply = () => answer('ok');
    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'ernie/smartMode', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 50 && guard.status().busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.status().busy, false);
    // A guest answer during generation means the Baidu session expired.
    state.reply = () => answer('convidado').replace(basedata(), basedata(false));
    await assert.rejects(async () => collect(await provider.generate('Sessão expirada', 'ernie/smartMode', false)), (e: any) => e.status === 401);
    assert.equal((await provider.status()).state, 'login_required');
    assert.equal(guard.status().busy, false);
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    state.login = 0;
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    const error = apiError(new UpstreamError('Ernie login is required.', 401), 'ernie_login_required').error;
    assert.equal(error.help_url, 'https://wenxin.baidu.com/'); assert.match(error.user_action, /Concluir login/);
    assert.match(error.user_action, /conta Baidu/); assert.doesNotMatch(error.user_action, /DeepSeek|bloqueado em navegadores/);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Ernie early manual confirmation reopens login and successful confirmation saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ernie-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new ErnieProvider();
  let login = 0, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://wenxin.baidu.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composer(login) }));
      await page.goto('https://wenxin.baidu.com/');
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    assert.equal((await provider.status()).confirmationRequired, true);
    await assert.rejects(() => provider.confirmLogin(), /Concluir login/);
    await assert.rejects(() => provider.finishLogin(), /Conclua o acesso/);
    assert.equal(reopened, 1); assert.equal((await provider.status()).confirmationRequired, true);
    login = 1;
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
