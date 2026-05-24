#!/usr/bin/env bash
set -euo pipefail

echo "[deepsproxy] Cleaning up zombie processes from previous runs..."

# Kill the main deepsproxy node process
if pgrep -f "deepsproxy.*src/index.ts" > /dev/null 2>&1; then
  echo "[deepsproxy] Killing existing deepsproxy node process..."
  pkill -f "deepsproxy.*src/index.ts" 2>/dev/null || true
fi

# Kill chromium instances using the deepseek profile
if pgrep -f "chrome-headless-shell.*deepseek_profile" > /dev/null 2>&1; then
  echo "[deepsproxy] Killing zombie chromium processes..."
  pkill -f "chrome-headless-shell.*deepseek_profile" 2>/dev/null || true
fi

sleep 1

# Verify port 46191 is free
if ss -tlnp 2>/dev/null | grep -q ":46191 " || netstat -tlnp 2>/dev/null | grep -q ":46191 "; then
  echo "[deepsproxy] Port 46191 still in use, force killing..."
  fuser -k 46191/tcp 2>/dev/null || true
  sleep 1
fi

cd /root/.hermes/apps/deepsproxy
# Keep the OpenAI-compatible API on the Hermes-configured port and force
# Playwright/Chromium to run headless so no WSLg browser window is opened.
export PORT="${PORT:-46191}"
export PLAYWRIGHT_HEADLESS="${PLAYWRIGHT_HEADLESS:-true}"
export DEEPSPROXY_DEV_LOG="${DEEPSPROXY_DEV_LOG:-true}"
export DEEPSPROXY_LOG_DIR="${DEEPSPROXY_LOG_DIR:-/root/.hermes/apps/deepsproxy/logs}"
mkdir -p "${DEEPSPROXY_LOG_DIR}"
echo "[deepsproxy] Starting on port ${PORT} (dev log: ${DEEPSPROXY_DEV_LOG}, log dir: ${DEEPSPROXY_LOG_DIR})..."
exec npm start
