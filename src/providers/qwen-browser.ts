import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';

export interface QwenResponse {
  status: number;
  contentType: string;
  retryAfter: string | null;
  chunks: AsyncIterable<string>;
  cancel(): Promise<void>;
}

/** Fetch and reader both stay in Chromium, which owns cookies and the worker egress proxy. */
export async function qwenBrowserFetch(page: Page, url: string, headers: Record<string, string>,
  body?: unknown, signal?: AbortSignal): Promise<QwenResponse> {
  signal?.throwIfAborted();
  const id = randomUUID();
  let cancelled = false;
  const cancel = async () => {
    cancelled = true;
    await page.evaluate(id => {
      const streams = (globalThis as any).__deepsproxyQwenStreams;
      const entry = streams?.[id];
      if (entry) { entry.controller.abort(); void entry.reader?.cancel().catch(() => {}); delete streams[id]; }
    }, id).catch(() => undefined);
  };
  const abort = () => { void cancel(); };
  signal?.addEventListener('abort', abort, { once: true });
  // Includes headers, body and an abandoned iterator; never leave a browser fetch running indefinitely.
  const timeout = setTimeout(() => { void cancel(); }, 180_000);
  const cleanup = async () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); await cancel(); };
  try {
    const meta = await page.evaluate(async ({ id, url, headers, body }) => {
      const streams = (globalThis as any).__deepsproxyQwenStreams ??= Object.create(null);
      const entry: any = { controller: new AbortController(), decoder: new TextDecoder() };
      streams[id] = entry;
      try {
        const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers,
          credentials: 'include', ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: entry.controller.signal });
        if (!response.body) throw new Error('Qwen response has no body.');
        entry.reader = response.body.getReader();
        return { status: response.status, contentType: response.headers.get('content-type') || '', retryAfter: response.headers.get('retry-after') };
      } catch (error) { delete streams[id]; throw error; }
    }, { id, url, headers, body });
    if (cancelled || signal?.aborted) { signal?.throwIfAborted(); throw new Error('Qwen request cancelled.'); }
    const chunks = (async function* () {
      try {
        while (true) {
          signal?.throwIfAborted();
          if (cancelled) throw new Error('Qwen request cancelled or timed out.');
          const chunk = await page.evaluate(async id => {
            const entry = (globalThis as any).__deepsproxyQwenStreams?.[id];
            if (!entry) throw new Error('Qwen stream was cancelled.');
            const { done, value } = await entry.reader.read();
            return { done, text: done ? entry.decoder.decode() : entry.decoder.decode(value, { stream: true }) };
          }, id);
          signal?.throwIfAborted();
          if (chunk.text) yield chunk.text;
          if (chunk.done) return;
        }
      } finally { await cleanup(); }
    })();
    return { ...meta, chunks, cancel: cleanup };
  } catch (error) { await cleanup(); signal?.throwIfAborted(); throw error; }
}

export async function qwenResponseJson(response: QwenResponse): Promise<any> {
  let text = '';
  for await (const chunk of response.chunks) {
    text += chunk;
    if (text.length > 4 * 1024 * 1024) throw new Error('Qwen JSON response exceeded size limit.');
  }
  try { return JSON.parse(text); } catch { throw new Error('Qwen returned a non-JSON response; manual browser validation may be required.'); }
}
