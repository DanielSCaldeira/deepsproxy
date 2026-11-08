import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Builds the public, sanitized integration matrix from private gateway smoke reports
// (scripts/smoke-all-providers.ts) and the Zed protocol replay summary (scripts/zed-replay.ts).
const args = process.argv.slice(2);
const zedIndex = args.indexOf('--zed');
const zedPath = zedIndex >= 0 ? args.splice(zedIndex, 2)[1] : '.cache/zed-replay/summary.json';
const paths = args;
if (!paths.length) throw new Error('Usage: tsx scripts/report-integrations.ts [--zed summary.json] <private-report.json> ... (oldest first)');

// Short, content-free failure categories: the raw messages can quote model output.
function category(error: unknown) {
  const text = String(error || '');
  if (!text) return null;
  const http = text.match(/HTTP (\d{3})/);
  if (http) return `http_${http[1]}`;
  if (/não anunciado/i.test(text)) return 'not_advertised';
  if (/markers leaked/i.test(text)) return 'tool_markers_leaked';
  if (/\[DONE\]/.test(text)) return 'sse_incomplete';
  if (/strictly equal|deepStrictEqual/.test(text)) return 'unexpected_answer';
  if (/timeout|aborted/i.test(text)) return 'timeout';
  if (/Falha repetida|transporte/i.test(text)) return 'transport';
  return 'other';
}

const providers = new Map<string, any>();
const sources: any[] = [];
for (const path of paths) {
  const raw = await readFile(path, 'utf8'), report = JSON.parse(raw.replace(/^﻿/, ''));
  sources.push({ path, sha256: createHash('sha256').update(raw).digest('hex'), startedAt: report.startedAt,
    finishedAt: report.finishedAt || null, revision: report.revision || null, fingerprint: report.fingerprint || null,
    temporaryKeyRevoked: report.temporaryKeyRevoked === true });
  for (const p of report.providers) {
    const provider = providers.get(p.provider) || { provider: p.provider, models: [], cases: new Map() };
    provider.models = [...new Set([...provider.models, ...(p.models || [])])];
    if (p.state || p.initialState) provider.state = p.state || p.initialState;
    provider.unavailable = Boolean(p.error);
    provider.error = p.error ? String(p.error).split('\n')[0].slice(0, 160) : null;
    for (const c of p.cases || []) {
      // Deliberate allowlist: never publish request bodies, provider status payloads or response text.
      provider.cases.set(c.model + '/' + c.name, { model: c.model, scenario: c.name, status: c.status,
        reason: c.status === 'passed' ? null : category(c.error), code: c.code || null,
        attempted: c.attempted !== false && (c.calls?.length || 0) > 0,
        requests: (c.calls || []).length, http: (c.calls || []).map((call: any) => call.http),
        elapsedMs: (c.calls || []).reduce((n: number, call: any) => n + (call.elapsedMs || 0), 0),
        clientTools: (c.clientExecuted || []).map((t: any) => t.name), source: path });
    }
    providers.set(p.provider, provider);
  }
}

let zed: any[] = [];
try {
  const raw = await readFile(zedPath, 'utf8');
  sources.push({ path: zedPath, sha256: createHash('sha256').update(raw).digest('hex'), kind: 'zed-replay' });
  zed = JSON.parse(raw.replace(/^﻿/, '')).results.map((r: any) => ({ model: r.model, provider: r.provider, status: r.status,
    reason: r.status === 'passed' ? null : (category(r.reason) === 'other' ? String(r.reason || '').slice(0, 120) : category(r.reason)),
    turns: r.turns, toolCalls: r.toolCalls || {}, invalidArguments: r.invalidArguments || 0, toolErrors: r.toolErrors || 0,
    http: [...new Set(r.http || [])], filesWritten: r.filesWritten || [], agentTestRuns: (r.agentTestRuns || []).length,
    independentTest: r.independentTest || null, elapsedMs: r.elapsedMs, finishedAt: r.finishedAt }));
} catch (error: any) { if (error.code !== 'ENOENT') throw error; }

const data = { generatedAt: new Date().toISOString(), sources,
  providers: [...providers.values()].map(p => ({ ...p, cases: [...p.cases.values()] })), zedReplay: zed };
await mkdir('docs/evidence', { recursive: true });
await writeFile('docs/evidence/integrations-2026-11-07.json', JSON.stringify(data, null, 2) + '\n');

const lines = ['# Matriz de validação das integrações', '', `Gerado em ${data.generatedAt} por \`scripts/report-integrations.ts\`. Leitura e conclusões: [validacao-integracoes.md](validacao-integracoes.md).`, '',
  'Resultados de chamadas reais ao gateway local. Aprovação na API não comprova execução no Zed; veja a seção do replay abaixo. Os arquivos privados de origem (`.cache/`) não são publicados.', '',
  '## API (cenários por modelo)', '',
  '| Provedor | Modelo | Aprovados | Falhas | Bloqueados | Não suportados | Pendentes | Motivos |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |'];
for (const p of data.providers) {
  if (!p.cases.length) lines.push(`| ${p.provider} | ${p.unavailable ? 'indisponível' : 'sem cenários concluídos'} | 0 | 0 | 0 | 0 | 1 | ${p.error || ''} |`);
  for (const model of [...new Set(p.cases.map((c: any) => c.model))]) {
    const cases = p.cases.filter((c: any) => c.model === model);
    const count = (s: string) => cases.filter((c: any) => c.status === s).length;
    const reasons = [...new Set(cases.map((c: any) => c.reason).filter(Boolean))].join(', ');
    lines.push(`| ${p.provider} | ${model} | ${count('passed')} | ${count('failed')} | ${count('blocked')} | ${count('unsupported')} | ${count('running')} | ${reasons} |`);
  }
}
if (zed.length) {
  lines.push('', '## Zed Agent (replay do protocolo)', '',
    'Tarefa: criar `<provedor>/sum.mjs` e `<provedor>/sum.test.mjs` com as tools do Zed e rodar os testes pelo terminal. O teste independente roda `node --test` no arquivo criado.', '',
    '| Modelo | Resultado | Turnos | Tools usadas | Execuções de teste pelo agente | Teste independente | Motivo |',
    '| --- | --- | ---: | --- | ---: | --- | --- |');
  for (const r of zed) {
    const tools = Object.entries(r.toolCalls).map(([name, n]) => `${name}×${n}`).join(', ');
    const t = r.independentTest;
    const independent = !t ? '—' : t.code === 0 ? `ok (${t.pass} pass)` : t.code === -1 ? 'arquivo ausente' : `falhou (${t.fail} fail)`;
    lines.push(`| ${r.model} | ${r.status} | ${r.turns} | ${tools} | ${r.agentTestRuns} | ${independent} | ${r.reason || ''} |`);
  }
}
lines.push('', 'Detalhes por cenário (códigos HTTP, tools executadas pelo cliente, tempos) no [JSON sanitizado](evidence/integrations-2026-11-07.json). Cada resultado conserva a origem; rodadas posteriores substituem somente o mesmo modelo/cenário.', '');
await writeFile('docs/validacao-integracoes-resultados.md', lines.join('\n'));
console.log(JSON.stringify({ providers: data.providers.length, cases: data.providers.reduce((n, p) => n + p.cases.length, 0), zed: zed.length }));
