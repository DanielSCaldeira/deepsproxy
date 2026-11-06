FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS browser-close
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libx11-dev && rm -rf /var/lib/apt/lists/*
COPY deploy/close-browser.c /close-browser.c
RUN gcc -std=c11 -O2 -Wall -Wextra -o /close-browser /close-browser.c -lX11

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./
COPY public ./public
COPY deploy ./deploy
COPY src/providers/QWEN-NOTICE ./notices/QWEN-NOTICE
USER node
CMD ["node","dist/production/server.js"]

FROM runtime AS worker
USER root
RUN npx playwright install --with-deps chromium && apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc gosu && rm -rf /var/lib/apt/lists/*
RUN mv /root/.cache/ms-playwright /ms-playwright && chmod -R a+rX /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY deploy/browser-policy.json /etc/chromium/policies/managed/deepsproxy.json
COPY deploy/browser-policy.json /etc/opt/chrome/policies/managed/deepsproxy.json
# Keep browser-profile sign-in disabled without blocking the API's DevTools pipe.
COPY deploy/browser-signin-policy.json /etc/opt/chrome_for_testing/policies/managed/deepsproxy.json
COPY --from=browser-close /close-browser /usr/local/bin/deepsproxy-close-browser
RUN chmod +x /app/deploy/worker-entrypoint.sh
HEALTHCHECK --interval=3s --timeout=2s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health',{headers:{Authorization:'Bearer '+process.env.API_KEY}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/deploy/worker-entrypoint.sh"]
