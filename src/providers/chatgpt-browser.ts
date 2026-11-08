/** Installed before frontend scripts. Only the active, matching prompt is captured.
 * The original frontend receives its response unchanged; credentials stay in Chromium.
 */
export function installChatGPTCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyChatGPTInstalled) return;
  scope.__proxyChatGPTInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const capture = scope.__proxyChatGPT;
    let matching = false;
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const candidate = !!capture && !capture.claimed && url.origin === location.origin &&
        /^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname);
      const body = candidate ? (typeof init?.body === 'string' ? JSON.parse(init.body) :
        input instanceof Request ? await input.clone().json().catch(() => null) : null) : null;
      // Compare only for correlation; never rewrite the submitted text. Rich editors normalize
      // blank paragraphs and non-breaking spaces. The composer also rewrites Markdown on submit
      // (observed 2026-11-07: "## Title" is sent as "\## Title" and "(https://x)" as
      // "([https://x](https://x))"), so long prompts match when every letter and digit of the
      // prompt appears, in order, in a message of comparable length.
      const target = capture?.prompt?.replace(/\s+/g, ' ').trim();
      const skeleton = capture?.prompt?.replace(/[^\p{L}\p{N}]/gu, '') ?? '';
      matching = candidate &&
        Array.isArray(body?.messages) && body.messages.some((m: any) => m?.author?.role === 'user' &&
          m?.content?.parts?.some((part: unknown) => {
            if (typeof part !== 'string') return false;
            if (part.replace(/\s+/g, ' ').trim() === target) return true;
            if (skeleton.length < 32) return false;
            const sent = part.replace(/[^\p{L}\p{N}]/gu, '');
            if (sent.length > skeleton.length * 1.25 + 200) return false;
            let found = 0;
            for (let i = 0; i < sent.length && found < skeleton.length; i++) if (sent[i] === skeleton[found]) found++;
            return found === skeleton.length;
          }));
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
            // Bounded error decoding; no upstream message or token crosses this boundary.
            let text = '';
            while (text.length < 65536) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
            try { const body = JSON.parse(text); const code = body.error?.code ?? body.detail?.code ?? body.code;
              if (typeof code === 'string' && /^[a-z_]{1,80}$/.test(code)) capture.code = code;
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
        } catch { capture.error = 'stream_failed'; }
        finally { capture.done = true; void reader?.cancel().catch(() => {}); }
      })();
      return response;
    } catch (error) { capture.error ??= 'request_failed'; capture.done = true; throw error; }
  };
}
