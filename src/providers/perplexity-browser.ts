/** Installed before frontend scripts. Only the active, matching prompt is captured.
 * The frontend's own SSE client calls the global fetch for /rest/sse/perplexity_ask;
 * its response is cloned unchanged and credentials stay in Chromium.
 */
export function installPerplexityCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyPerplexityInstalled) return;
  scope.__proxyPerplexityInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const capture = scope.__proxyPerplexity;
    let matching = false;
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const candidate = !!capture && !capture.claimed && url.origin === location.origin && url.pathname === '/rest/sse/perplexity_ask';
      const body = candidate ? (typeof init?.body === 'string' ? JSON.parse(init.body) :
        input instanceof Request ? await input.clone().json().catch(() => null) : null) : null;
      // Lexical may normalize or drop paragraph breaks; ignore whitespace only
      // for correlation and never rewrite the submitted text.
      matching = candidate && typeof body?.query_str === 'string' &&
        body.query_str.replace(/\s+/g, '') === capture.prompt.replace(/\s+/g, '');
      if (matching) {
        capture.claimed = true;
        if (capture.model !== 'auto' && body.params?.model_preference !== capture.model) {
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
      capture.challenge = !!response.headers.get('cf-mitigated')?.includes('challenge');
      const copy = response.clone();
      void (async () => {
        const reader = copy.body?.getReader();
        const decoder = new TextDecoder();
        try {
          if (!reader) throw new Error('missing_body');
          if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
            // Bounded error decoding; no upstream message or token crosses this boundary.
            let text = '';
            while (text.length < 65536) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
            try { const body = JSON.parse(text); const code = body.detail?.error_code ?? body.error_code ?? body.error?.code;
              if (typeof code === 'string' && /^[A-Za-z_]{1,80}$/.test(code)) capture.code = code;
            } catch { /* An HTML challenge is unavailable, not an expired login. */ }
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
