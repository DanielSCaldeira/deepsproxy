/** Installed before frontend scripts. Only the active, matching prompt is captured.
 * The original frontend receives its response unchanged; credentials stay in Chromium.
 */
export function installGrokCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyGrokInstalled) return;
  scope.__proxyGrokInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const capture = scope.__proxyGrok;
    let matching = false;
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (capture && !capture.claimed && url.origin === location.origin && url.pathname === '/' &&
          (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'POST') capture.renderedTransport = true;
      const candidate = !!capture && !capture.claimed && url.origin === location.origin &&
        /^\/rest\/app-chat\/conversations\/new\/?$/.test(url.pathname);
      const body = candidate ? (typeof init?.body === 'string' ? JSON.parse(init.body) :
        input instanceof Request ? await input.clone().json().catch(() => null) : null) : null;
      // Rich editors normalize blank paragraphs and non-breaking spaces.
      // Compare only for correlation; never rewrite the submitted text.
      matching = candidate && typeof body?.message === 'string' &&
        body.message.replace(/\s+/g, ' ').trim() === capture.prompt.replace(/\s+/g, ' ').trim();
      if (matching) {
        capture.claimed = true;
        // A specific mode must be honored when the request reports its mode.
        if (capture.mode !== 'auto' && typeof body.modeId === 'string' && body.modeId.toLowerCase() !== capture.mode) {
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
          if (!response.ok) {
            // Bounded error decoding; no upstream message or token crosses this boundary.
            let text = '';
            while (text.length < 65536) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
            try { const body = JSON.parse(text); const code = body.error?.code ?? body.code;
              if ((typeof code === 'string' && /^[\w-]{1,80}$/.test(code)) || Number.isSafeInteger(code)) capture.code = String(code);
            } catch { /* A Cloudflare challenge page is unavailable, not an expired login. */ }
            capture.error = 'upstream'; return;
          }
          while (true) {
            const part = await reader.read();
            const text = part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
            if (capture.bytes + text.length > 4 * 1024 * 1024) throw new Error('buffer_limit');
            if (text) { capture.chunks.push(text); capture.bytes += text.length; }
            if (part.done) break;
          }
        } catch { capture.error = 'stream_failed'; }
        finally { capture.done = true; void reader?.cancel().catch(() => {}); }
      })();
      return response;
    } catch (error) { capture.error ??= 'request_failed'; capture.done = true; throw error; }
  };
}
