/** Installed before the claude.ai frontend scripts. Only the completion request
 * carrying the active prompt is captured; the frontend still receives its own
 * response unchanged and credentials never leave Chromium.
 *
 * Observed in the public bundles (2026-11-06): POST
 * /api/organizations/{org}/chat_conversations/{conversation}/completion (or
 * `completion2` on the alternate backend) with a JSON body containing `prompt`
 * and `model`; large bodies may be sent gzip-compressed (Content-Encoding: gzip).
 */
export function installClaudeCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyClaudeInstalled) return;
  scope.__proxyClaudeInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const capture = scope.__proxyClaude;
    let matching = false;
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const candidate = !!capture && !capture.claimed && method === 'POST' && url.origin === location.origin &&
        /^\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion2?$/.test(url.pathname);
      // No named helper functions here: this source is serialized into the page.
      let body: any = null;
      if (candidate) {
        try {
          let raw: unknown = init?.body;
          if (raw === undefined && input instanceof Request) raw = await input.clone().arrayBuffer();
          if (typeof raw === 'string') body = JSON.parse(raw);
          else {
            let bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) :
              ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) :
              raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : null;
            if (bytes && bytes[0] === 0x1f && bytes[1] === 0x8b) {
              const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
              bytes = new Uint8Array(await new Response(stream).arrayBuffer());
            }
            if (bytes) body = JSON.parse(new TextDecoder().decode(bytes));
          }
        } catch { body = null; }
      }
      // Rich editors normalize blank paragraphs and non-breaking spaces.
      // Compare only for correlation; never rewrite the submitted text.
      matching = candidate && typeof body?.prompt === 'string' &&
        body.prompt.replace(/\s+/g, ' ').trim() === String(capture.prompt).replace(/\s+/g, ' ').trim();
      if (matching) {
        capture.claimed = true;
        // Specific model selections must be honored by the frontend request.
        if (capture.model !== 'auto' && body.model !== capture.model) {
          capture.error = 'model_mismatch'; capture.done = true;
          throw new Error('Requested model selection was not honored.');
        }
      }
    } catch (error) { if (capture?.error) throw error; }
    if (!matching) return original.call(this, input, init);
    const controller = new AbortController(); capture.controller = controller;
    const previousSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = previousSignal ? AbortSignal.any([previousSignal, controller.signal]) : controller.signal;
    try {
      const response = await original.call(this, input, { ...init, signal });
      capture.status = response.status; capture.retryAfter = response.headers.get('retry-after');
      const copy = response.clone();
      void (async () => {
        const reader = copy.body?.getReader();
        const decoder = new TextDecoder();
        try {
          if (!reader) throw new Error('missing_body');
          if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
            // Bounded error decoding; only validated codes cross this boundary.
            let text = '';
            while (text.length < 65536) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
            try {
              const body = JSON.parse(text), error = body?.error ?? {};
              const code = error.details?.error_code ?? error.code, type = error.type;
              if (typeof code === 'string' && /^[a-z_]{1,80}$/.test(code)) capture.code = code;
              if (typeof type === 'string' && /^[a-z_]{1,80}$/.test(type)) capture.errorType = type;
              // Usage limits embed {"type":"exceeded_limit","resetsAt":<unix seconds>} in the message.
              const limit = typeof error.message === 'string' ? JSON.parse(error.message) : null;
              if (Number.isFinite(limit?.resetsAt)) capture.resetsAt = Number(limit.resetsAt);
              if (limit?.type === 'exceeded_limit') capture.code ??= 'exceeded_limit';
            } catch { /* A challenge HTML response is unavailable, not an expired login. */ }
            capture.error = 'upstream'; return;
          }
          while (true) {
            const part = await reader.read();
            const text = part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
            if (capture.bytes + text.length > 4 * 1024 * 1024) throw new Error('buffer_limit');
            if (text) { capture.chunks.push(text); capture.bytes += text.length; }
            if (part.done) break;
          }
        } catch { capture.error ??= 'stream_failed'; }
        finally { capture.done = true; void reader?.cancel().catch(() => {}); }
      })();
      return response;
    } catch (error) { capture.error ??= 'request_failed'; capture.done = true; throw error; }
  };
}
