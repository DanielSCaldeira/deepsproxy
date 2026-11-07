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
      let isChat = false, m365 = false;
      try {
        const url = new URL(socket.url);
        m365 = url.hostname === 'substrate.office.com' && /\/Chathub\/?$/i.test(url.pathname);
        isChat = m365 || (['copilot.microsoft.com', 'copilot.com'].includes(url.hostname) && url.pathname === '/c/api/chat');
      } catch { /* not a URL */ }
      if (isChat && !watched.has(socket)) {
        watched.add(socket);
        socket.addEventListener('message', function (event: MessageEvent) {
          const capture = scope.__proxyCopilot;
          if (!capture?.claimed || capture.done || capture.socket !== socket || typeof event.data !== 'string') return;
          if (m365) {
            // The native Microsoft 365 client owns SignalR authentication and submission.
            // Copy only this invocation's answer; keep snapshots until completion because
            // the service can revise an earlier streamed message.
            for (const raw of event.data.split('\u001e').filter(Boolean)) {
              let frame: any;
              try { frame = JSON.parse(raw); } catch { continue; }
              if (frame.invocationId !== undefined && frame.invocationId !== capture.invocationId) continue;
              if (raw.length > 4 * 1024 * 1024) { capture.error = 'buffer_limit'; capture.done = true; break; }
              const payload = frame.item ?? frame.arguments?.[0] ?? frame.result;
              const messages = payload?.messages;
              if (Array.isArray(messages)) {
                const reply = messages.filter((m: any) => m?.author === 'bot' && typeof m.text === 'string' &&
                  (!m.messageType || m.messageType === 'Chat')).at(-1);
                if (reply) capture.m365Text = reply.text;
              }
              const complete = frame.invocationId === capture.invocationId &&
                (frame.type === 3 || (frame.type === 2 && !!frame.item));
              if (!complete) continue;
              const result = payload?.result;
              if (frame.error || (result?.value && result.value !== 'Success')) {
                capture.error = 'service_error'; capture.done = true; break;
              }
              if (!capture.m365Text?.trim()) { capture.error = 'empty_answer'; capture.done = true; break; }
              const id = 'm365-answer';
              const frames = [JSON.stringify({event:'startMessage',messageId:id}),
                JSON.stringify({event:'appendText',messageId:id,text:capture.m365Text}), JSON.stringify({event:'done',messageId:id})];
              capture.chunks.push(...frames); capture.bytes += frames.join('').length; capture.done = true;
            }
            return;
          }
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
        if (m365) {
          for (const raw of data.split('\u001e').filter(Boolean)) {
            let frame: any;
            try { frame = JSON.parse(raw); } catch { continue; }
            const text = frame.arguments?.[0]?.message?.text;
            // The rich-text composer may add zero-width markers and reflow whitespace.
            // No named helper here: this function is serialized into the page.
            const invisible = new RegExp('[' + String.fromCharCode(0x200b) + '-' + String.fromCharCode(0x200d, 0x2060, 0xfeff) + '\\s]', 'g');
            if (typeof frame.invocationId !== 'string' || typeof text !== 'string' ||
              text.replace(invisible, '') !== String(capture.prompt).replace(invisible, '')) continue;
            if (capture.mode !== 'auto') { capture.error = 'mode_mismatch'; capture.done = true; return; }
            capture.claimed = true; capture.socket = socket; capture.invocationId = frame.invocationId;
            break;
          }
          return nativeSend.call(socket, data);
        }
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
