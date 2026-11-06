/** Installed before frontend scripts. Only the active, matching prompt is captured.
 * The original frontend receives its response unchanged; credentials stay in Chromium.
 * Self-contained: Playwright serializes this function into the page.
 */
export function installCohereCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyCohereInstalled) return;
  scope.__proxyCohereInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const capture = scope.__proxyCohere;
    let matching = false;
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      // Public Cohere chat API (v1/v2) used by the dashboard clients, or a same-origin chat route.
      const candidate = !!capture && !capture.claimed && method === 'POST' &&
        ((/^(stg\.)?api\.cohere\.(com|ai)$/.test(url.hostname) && /^\/v[12]\/chat\/?$/.test(url.pathname)) ||
         (url.origin === location.origin && /\/chat(\/stream)?\/?$/.test(url.pathname)));
      const body = candidate ? (typeof init?.body === 'string' ? JSON.parse(init.body) :
        input instanceof Request ? await input.clone().json().catch(() => null) : null) : null;
      let prompt: string | null = null, stale = false;
      if (typeof body?.message === 'string') {
        prompt = body.message;
        stale = Array.isArray(body.chat_history) && body.chat_history.some((m: any) => m?.role !== 'SYSTEM');
      } else if (Array.isArray(body?.messages)) {
        const turns = body.messages.filter((m: any) => m?.role !== 'system');
        const last = turns.at(-1);
        if (last?.role === 'user') {
          prompt = typeof last.content === 'string' ? last.content : Array.isArray(last.content)
            ? last.content.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('') : null;
          stale = turns.length > 1;
        }
      }
      // Rich editors normalize blank lines and spaces; compare only for correlation.
      matching = candidate && typeof prompt === 'string' &&
        prompt.replace(/\s+/g, ' ').trim() === String(capture.prompt).replace(/\s+/g, ' ').trim();
      if (matching) {
        capture.claimed = true;
        if (stale) { capture.error = 'stale_history'; capture.done = true; throw new Error('Previous conversation was not cleared.'); }
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
          if (!response.ok) {
            // Bounded error decoding; no upstream message or token crosses this boundary.
            let text = '';
            while (text.length < 65536) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
            try { const body = JSON.parse(text); const code = body.error?.code ?? body.code ?? body.error_code;
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

/** Runs in the dashboard page. Returns only status and booleans; never a token or identity.
 * No named inner functions: tsx would reference a `__name` helper absent from the page. */
export async function cohereSessionCheck(endpoint: string): Promise<{ status: number; authenticated: boolean; refreshable: boolean }> {
  const cookies = new Map(document.cookie.split('; ').map(c => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
  const token = cookies.get('access_token') ?? '';
  const refreshable = !!cookies.get('refresh_token');
  if (!token) return { status: 401, authenticated: false, refreshable };
  const response = await fetch(endpoint, { method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + decodeURIComponent(token) }, body: '{}' });
  if (!response.ok) return { status: response.status, authenticated: false, refreshable };
  const body = await response.json().catch(() => null);
  return { status: 200, authenticated: !!body?.user && typeof body.user === 'object', refreshable };
}
