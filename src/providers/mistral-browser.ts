// Both functions are serialized into the page by Playwright. They must not
// declare named inner functions: the TypeScript loader would inject helpers
// (`__name`) that do not exist in the page.

/** Installed before frontend scripts. Captures only the generation response of the
 * active prompt; the frontend receives its response unchanged and credentials stay
 * in Chromium. The request path is not hard-coded beyond `/api/chat` because the
 * authenticated transport was not observed (see docs/mistral-integration.md):
 * a same-origin POST is correlated by the prompt text, and a streaming response
 * (or `/api/chat`) is claimed. Telemetry and successful JSON mutations pass through.
 */
export function installMistralCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyMistralInstalled) return;
  scope.__proxyMistralInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const capture = scope.__proxyMistral;
    let candidate = false, chatPath = false;
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      chatPath = /^\/api\/chat(?:\/|$)/.test(url.pathname);
      if (capture && !capture.claimed && !capture.done && method === 'POST' && url.origin === location.origin &&
          !/^\/api\/trpc\/event\.|^\/cdn-cgi\//.test(url.pathname)) {
        const raw = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text().catch(() => '') : '';
        let body: unknown = raw;
        try { body = JSON.parse(raw); } catch { /* form or plain text body */ }
        // Rich editors normalize blank paragraphs and non-breaking spaces; compare only for correlation.
        const prompt = String(capture.prompt).replace(/\s+/g, ' ').trim();
        const strings: string[] = [], stack: Array<[unknown, number]> = [[body, 0]];
        while (stack.length && strings.length < 2000) {
          const [node, depth] = stack.pop()!;
          if (typeof node === 'string') strings.push(node.replace(/\s+/g, ' ').trim());
          else if (node && typeof node === 'object' && depth < 12) for (const item of Object.values(node).reverse()) stack.push([item, depth + 1]);
        }
        if (raw && prompt && (strings.includes(prompt) || strings.join(' ').replace(/\s+/g, ' ').includes(prompt))) {
          candidate = true; capture.promptSeen = true;
        }
        // A chat may be created by a JSON mutation first; the following stream
        // request then refers to the chat id instead of repeating the prompt.
        else if (capture.promptSeen && chatPath) candidate = true;
      }
    } catch { candidate = false; }
    if (!candidate) return original.call(this, input, init);
    const controller = new AbortController();
    const previousSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = previousSignal ? AbortSignal.any([previousSignal, controller.signal]) : controller.signal;
    let response: Response;
    try { response = await original.call(this, input, { ...init, signal }); }
    catch (error) { if (chatPath) { capture.claimed = true; capture.error ??= 'request_failed'; capture.done = true; } throw error; }
    const type = response.headers.get('content-type') ?? '';
    const streaming = /event-stream|ndjson|jsonl|text\/plain|octet-stream/.test(type);
    if (!chatPath && !streaming && response.ok) return response;
    if (capture.claimed || capture.done) return response;
    capture.claimed = true; capture.controller = controller;
    capture.status = response.status; capture.retryAfter = response.headers.get('retry-after');
    const copy = response.clone();
    void (async () => {
      const reader = copy.body?.getReader();
      const decoder = new TextDecoder();
      try {
        if (!reader) throw new Error('missing_body');
        if (!response.ok || /text\/html/.test(type)) {
          // Bounded error decoding; no upstream message or token crosses this boundary.
          let text = '';
          while (text.length < 65536) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
          try {
            const parsed = JSON.parse(text), body = Array.isArray(parsed) ? parsed[0] : parsed;
            const code = body?.error?.code ?? body?.error?.json?.data?.code ?? body?.detail?.code ?? body?.code ?? body?.type;
            if (typeof code === 'string' && /^[A-Za-z_]{1,80}$/.test(code)) capture.code = code.toLowerCase();
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
  };
}

/** Evaluated in the page. Returns booleans only; no session data leaves Chromium. */
export function inspectMistralPage(): { challenge: boolean; anonymous: boolean; signIn: boolean; composer: boolean; terms: boolean; limit: string | null } {
  const visible = new Set([...document.querySelectorAll('button, a, [role="dialog"], [role="alertdialog"], [contenteditable="true"]')]
    .filter(element => (element as HTMLElement).getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' &&
      !element.closest('[hidden],[aria-hidden="true"]')));
  const challenge = /^(Just a moment|Um momento)/i.test(document.title) ||
    !!document.querySelector('#challenge-form, #challenge-stage, [name="cf-turnstile-response"]');
  // Next.js RSC payload: anonymous visitors render providers with `"session":null`.
  const flight = (globalThis as any).__next_f;
  const payload = Array.isArray(flight) ? flight.map((entry: unknown) => Array.isArray(entry) ? entry.filter(v => typeof v === 'string').join('') : '').join('') : '';
  const anonymous = /"session":null/.test(payload);
  const signIn = [...document.querySelectorAll('button, a')].some(element => visible.has(element) &&
    /^(Sign in|Sign up|Log in|Entrar|Inscrever-se|Cadastre-se|Criar conta)$/i.test((element.textContent ?? '').trim()));
  const composer = [...document.querySelectorAll('[data-composer-editor] [contenteditable="true"], form [contenteditable="true"].ProseMirror, .rich-text-editor.ProseMirror[contenteditable="true"]')].some(element => visible.has(element));
  const terms = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(dialog => visible.has(dialog) &&
    /Terms of Service|Termos de (Serviço|Uso)/i.test(dialog.textContent ?? '') &&
    [...dialog.querySelectorAll('button')].some(button => /^(Accept and continue|Aceitar e continuar)$/i.test((button.textContent ?? '').trim())));
  const text = document.body?.innerText ?? '';
  const limit = /You have reached the quota for your current plan|Login to unlock more messages/i.test(text) ? 'quota'
    : /This model is at full capacity right now|The model is under heavy usage right now/i.test(text) ? 'capacity' : null;
  return { challenge, anonymous, signIn, composer, terms, limit };
}
