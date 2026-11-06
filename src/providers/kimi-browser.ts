/** Installed before the frontend scripts (the Connect transport keeps a reference
 * to `globalThis.fetch` taken at module load). Only the Chat request carrying the
 * active prompt is observed; the frontend receives its response unchanged and
 * credentials stay in Chromium. Response bytes cross to Node as base64 chunks.
 * Keep this function free of nested named functions: it is serialized as-is.
 */
export function installKimiCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyKimiInstalled) return;
  scope.__proxyKimiInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const capture = scope.__proxyKimi;
    let matching = false;
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const candidate = !!capture && !capture.claimed && url.origin === location.origin &&
        url.pathname === '/apiv2/kimi.gateway.chat.v1.ChatService/Chat';
      let body: any = null;
      if (candidate) {
        let raw: any = init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : null);
        if (raw instanceof ArrayBuffer) raw = new Uint8Array(raw);
        else if (ArrayBuffer.isView(raw)) raw = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        if (raw instanceof Uint8Array) {
          // Connect streaming request: one uncompressed envelope (flag 0, 4-byte length, JSON).
          const length = raw.length >= 5 ? new DataView(raw.buffer, raw.byteOffset + 1, 4).getUint32(0, false) : -1;
          raw = raw[0] === 0 && length === raw.length - 5 ? raw.subarray(5) : raw;
          raw = new TextDecoder().decode(raw);
        }
        if (typeof raw === 'string') { try { body = JSON.parse(raw); } catch { body = null; } }
      }
      const blocks = body?.message?.blocks;
      matching = candidate && Array.isArray(blocks) && blocks.some((block: any) => typeof block?.text?.content === 'string' &&
        // Rich editors normalize blank paragraphs and spaces. Compare only for correlation.
        block.text.content.replace(/\s+/g, ' ').trim() === capture.prompt.replace(/\s+/g, ' ').trim());
      if (matching) {
        capture.claimed = true;
        const model = body?.options?.model;
        // A specific selection must be honored when the frontend states its model.
        if (typeof model === 'string' && model && Array.isArray(capture.aliases) && capture.aliases.length && !capture.aliases.includes(model)) {
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
        try {
          if (!reader) throw new Error('missing_body');
          if (!response.ok || !response.headers.get('content-type')?.includes('application/connect+json')) {
            // Bounded error decoding; only enumerated codes cross this boundary.
            let text = ''; const decoder = new TextDecoder();
            while (text.length < 65536) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
            try {
              const parsed = JSON.parse(text);
              if (typeof parsed?.code === 'string' && /^[a-z_]{1,40}$/.test(parsed.code)) capture.code = parsed.code;
              for (const detail of Array.isArray(parsed?.details) ? parsed.details : [])
                if (typeof detail?.debug?.reason === 'string' && /^REASON_[A-Z0-9_]{1,80}$/.test(detail.debug.reason)) capture.reason = detail.debug.reason;
            } catch { /* Challenge HTML is unavailable, not an expired login. */ }
            capture.error = 'upstream'; return;
          }
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            if (capture.bytes + part.value.length > 4 * 1024 * 1024) throw new Error('buffer_limit');
            let binary = '';
            for (let i = 0; i < part.value.length; i += 0x8000) binary += String.fromCharCode(...part.value.subarray(i, i + 0x8000));
            capture.chunks.push(btoa(binary)); capture.bytes += part.value.length;
          }
        } catch { capture.error ??= 'stream_failed'; }
        finally { capture.done = true; void reader?.cancel().catch(() => {}); }
      })();
      return response;
    } catch (error) { capture.error ??= 'request_failed'; capture.done = true; throw error; }
  };
}
