import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const base = (process.env.DSP_API_BASE || 'http://localhost:3440/v1').replace(/\/$/, '');
const key = process.env.DSP_API_KEY || await readFile('.cache/ernie-api-key.txt', 'utf8').then(text => text.trim()).catch(() => '');
if (!key) throw new Error('Defina DSP_API_KEY ou salve a chave de teste em .cache/ernie-api-key.txt.');
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const report: Record<string, unknown> = { base, model: 'ernie/smartMode', timestamp: new Date().toISOString() };

async function request(path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET', headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${path}: HTTP ${response.status}. Verifique o status da conta e os logs do gateway.`);
  }
  return response;
}

try {
  const catalog = await (await request('/models')).json();
  assert.ok(catalog.data?.some((model: { id: string }) => model.id === 'ernie/smartMode'), 'ernie/smartMode indisponível: conclua o login e confira o catálogo.');
  for (const stream of [false, true]) {
    const expected = stream ? 'TESTE_ERNIE_STREAM_OK' : 'TESTE_ERNIE_OK';
    const body = { model: 'ernie/smartMode', messages: [{ role: 'user', content: `Responda apenas: ${expected}` }], stream };
    const started = Date.now();
    const response = await request('/chat/completions', body);
    let text = '', events = 0, done = false;
    if (!stream) {
      const json = await response.json();
      text = json.choices?.[0]?.message?.content;
    } else {
      assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      let pending = '';
      const event = (block: string) => {
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        if (data === '[DONE]') { done = true; return; }
        const chunk = JSON.parse(data);
        assert.ok(!chunk.error, 'O streaming retornou erro.');
        text += chunk.choices?.[0]?.delta?.content || '';
        events++;
      };
      while (true) {
        const part = await reader.read();
        pending += decoder.decode(part.value, { stream: !part.done });
        // Normalize complete CRLF pairs while preserving a trailing split CR.
        pending = pending.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          event(pending.slice(0, boundary)); pending = pending.slice(boundary + 2);
        }
        if (part.done) break;
      }
      if (pending.trim()) event(pending);
      assert.ok(events > 0 && done, 'Streaming sem eventos ou sem [DONE].');
    }
    report[stream ? 'streaming' : 'normal'] = { request: body, http: response.status, text, elapsedMs: Date.now() - started, ...(stream ? { events, done } : {}) };
    assert.equal(text?.trim(), expected);
  }
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/ernie-live-api-result.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
