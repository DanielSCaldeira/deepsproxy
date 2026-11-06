/** Installed before frontend scripts. Only the active, matching prompt is captured.
 * The frontend posts to https://chat.baidu.com/aichat/api/conversation (or its
 * chat-ws fallback) and receives its response unchanged; credentials stay in Chromium.
 */
export function installErnieCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyErnieInstalled) return;
  scope.__proxyErnieInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const capture = scope.__proxyErnie;
    let matching = false;
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const candidate = !!capture && !capture.claimed && method === 'POST' && url.protocol === 'https:' &&
        /(^|\.)baidu\.com$/.test(url.hostname) && url.pathname === '/aichat/api/conversation';
      const body = candidate ? (typeof init?.body === 'string' ? JSON.parse(init.body) :
        input instanceof Request ? await input.clone().json().catch(() => null) : null) : null;
      const expected = String(capture?.prompt ?? '').replace(/\s+/g, ' ').trim();
      const queries = Array.isArray(body?.message?.query) ? body.message.query : [];
      // Compare only for correlation; never rewrite the submitted text.
      matching = candidate && queries.some((part: any) => part?.type === 'TEXT' &&
        typeof part?.data?.text?.query === 'string' && part.data.text.query.replace(/\s+/g, ' ').trim() === expected);
      if (matching) {
        capture.claimed = true;
        const used = body?.message?.searchInfo?.usedModel?.modelName;
        if (used !== capture.model) {
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
            // No upstream body crosses this boundary; a challenge page is not an expired login.
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
