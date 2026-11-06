/** Installed before frontend scripts. The Copilot frontend talks to
 * `wss://copilot.microsoft.com/c/api/chat?api-version=2&...` from the main thread.
 * Only the outgoing `send` event carrying the active prompt is claimed; afterwards only
 * events of that conversation/AI message are copied. Frames are never rewritten; the
 * access token in the socket URL never leaves Chromium.
 *
 * The frontend's own `GET /c/api/user` response is observed to expose only the account
 * tier (`guest` for anonymous visitors), without identity or token.
 *
 * This function is serialized into the page: it must not declare named helper functions,
 * because tsx/esbuild `keepNames` would reference an undefined `__name` there.
 */
export function installCopilotCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyCopilotInstalled) return;
  scope.__proxyCopilotInstalled = true;
  const Native = globalThis.WebSocket;
  const watched = new WeakSet<WebSocket>();
  if (typeof Native === 'function') {
    const nativeSend = Native.prototype.send;
    Native.prototype.send = function (this: WebSocket, data: any) {
      const socket = this;
      let isChat = false;
      try { isChat = new URL(socket.url).pathname === '/c/api/chat'; } catch { /* not a URL */ }
      if (isChat && !watched.has(socket)) {
        watched.add(socket);
        socket.addEventListener('message', function (event: MessageEvent) {
          const capture = scope.__proxyCopilot;
          if (!capture?.claimed || capture.done || capture.socket !== socket || typeof event.data !== 'string') return;
          let value: any;
          try { value = JSON.parse(event.data); } catch { return; }
          const kind = value?.event, id = value?.messageId;
          const known = typeof id === 'string' && capture.messages.includes(id);
          const relevant = (kind === 'startMessage' && value.conversationId === capture.conversationId) || known ||
            ['error', 'banned', 'turnLimitReached'].includes(kind);
          if (!relevant) return;
          if (kind === 'startMessage' && typeof id === 'string' && !known) capture.messages.push(id);
          if (capture.bytes + event.data.length > 4 * 1024 * 1024) { capture.error = 'buffer_limit'; capture.done = true; return; }
          capture.chunks.push(event.data); capture.bytes += event.data.length;
          if (['done', 'error', 'banned', 'turnLimitReached', 'chatMessageError'].includes(kind)) capture.done = true;
        });
        socket.addEventListener('close', function () {
          const capture = scope.__proxyCopilot;
          // The frontend reconnects and may recover; a lost socket is not a completed answer.
          if (capture?.claimed && !capture.done && capture.socket === socket) { capture.error = 'socket_closed'; capture.done = true; }
        });
      }
      const capture = scope.__proxyCopilot;
      if (isChat && capture && !capture.claimed && typeof data === 'string') {
        let frame: any = null;
        try { frame = JSON.parse(data); } catch { /* not JSON */ }
        const text = frame?.event === 'send' && Array.isArray(frame.content)
          ? frame.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : null;
        // Editors may normalize whitespace; compare only for correlation.
        if (text !== null && text.replace(/\s+/g, ' ').trim() === String(capture.prompt).replace(/\s+/g, ' ').trim()) {
          capture.claimed = true; capture.socket = socket; capture.conversationId = frame.conversationId; capture.sentMode = frame.mode;
          if (capture.mode !== 'auto' && frame.mode !== capture.mode) {
            // Never dispatch a message in a mode other than the requested one.
            capture.error = 'mode_mismatch'; capture.done = true; return;
          }
        }
      }
      return nativeSend.call(socket, data);
    };
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const response = await originalFetch.call(this, input, init);
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.origin === location.origin && url.pathname === '/c/api/user' && method.toUpperCase() === 'GET') {
        const observed = { status: response.status, tier: null as string | null, at: Date.now() };
        scope.__proxyCopilotUser = observed;
        if (response.ok) void response.clone().json().then(function (body: any) {
          observed.tier = typeof body?.accountTier === 'string' && /^[\w-]{1,40}$/.test(body.accountTier) ? body.accountTier : 'unknown';
        }).catch(function () { /* observation only */ });
      }
    } catch { /* observation only */ }
    return response;
  };
}
