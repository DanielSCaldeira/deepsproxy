/**
 * Installed before frontend scripts. Only the conversation request carrying the
 * active prompt is captured; the frontend still receives its response. Cookies,
 * ID tokens and request headers stay inside Chromium.
 *
 * Browser-side code avoids named local function bindings: tsx may inject a
 * `__name` helper that does not exist in the page.
 */
export function installQuillBotCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyQuillBotInstalled) return;
  scope.__proxyQuillBotInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const capture = scope.__proxyQuillBot;
    let matching = false;
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const route = /^\/api\/ai-chat\/chat\/conversation\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
      const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (capture && !capture.claimed && url.origin === location.origin && route && method === 'POST') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) :
          input instanceof Request ? await input.clone().json().catch(() => null) : null;
        const content = body?.message?.content;
        // The textarea and the frontend may normalize blank lines or trailing
        // separators. Compare only for correlation; never rewrite the request.
        matching = typeof content === 'string' &&
          content.replace(/\s+/g, ' ').trim() === String(capture.prompt).replace(/\s+/g, ' ').trim();
        if (matching) {
          capture.claimed = true; capture.chatId = route[1];
          const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
          // Same cancel route the frontend calls when its own request is aborted.
          capture.cancel = () => original.call(globalThis, `/api/ai-chat/chat/conversation/${route[1]}/cancel`,
            { method: 'POST', headers, credentials: 'include', body: '{}' }).catch(() => undefined);
        }
      }
    } catch { matching = false; }
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
            // Bounded error decoding; only a short code crosses this boundary.
            let text = '';
            while (text.length < 65536) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
            try {
              const body = JSON.parse(text); const code = body?.code ?? body?.error?.code;
              if (typeof code === 'string' && /^[A-Za-z0-9_/-]{1,80}$/.test(code)) capture.code = code;
            } catch { /* A challenge page is unavailable, not an expired login. */ }
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

/** Result of the in-page authentication probe. No identity or token is returned. */
export interface QuillBotAuthProbe {
  challenge: boolean;
  cookie: boolean;
  status: number;
  remaining: number | null;
}

/**
 * Runs inside the page. `authenticated` is the site's own client cookie and
 * `/api/auth/user-cache` answered 403 COM_FORBIDDEN for a visitor during the
 * public inspection. The freemium limit is read only as numbers.
 */
export async function quillBotAuthProbe(): Promise<QuillBotAuthProbe> {
  // Cloudflare's interstitial observed for headless Chromium ("Just a moment...").
  const challenge = /^(Just a moment|Um momento)/i.test(document.title.trim());
  const cookie = /(?:^|;\s*)authenticated=true(?:;|$)/.test(document.cookie);
  let status = 0, remaining: number | null = null;
  if (!challenge) {
    try {
      const response = await fetch('/api/auth/user-cache', { credentials: 'include', cache: 'no-store' });
      status = response.status; await response.body?.cancel();
    } catch { status = 0; }
    try {
      const response = await fetch('/api/ai-chat/chat/limit/ai-chat.chat', { credentials: 'include', cache: 'no-store' });
      const body = response.ok ? await response.json() : null;
      if (typeof body?.data?.limit === 'number' && typeof body?.data?.remaining === 'number') remaining = body.data.remaining;
    } catch { remaining = null; }
  }
  return { challenge, cookie, status, remaining };
}
