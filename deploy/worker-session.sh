#!/bin/sh
set -eu
export HOME=/home/node
vpid=0
apid=0
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
xpid=$!
cleanup() {
  [ "$apid" -eq 0 ] || kill "$apid" 2>/dev/null || true
  [ "$vpid" -eq 0 ] || kill "$vpid" 2>/dev/null || true
  kill "$xpid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'kill "$apid" 2>/dev/null || true; wait "$apid" 2>/dev/null || true; exit 0' INT TERM
count=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  count=$((count+1))
  [ "$count" -lt 50 ] || exit 1
  sleep 0.1
done
x11vnc -display :99 -listen 0.0.0.0 -rfbport 5900 -forever -shared -nopw -noxdamage -nosel -noprimary -quiet &
vpid=$!
node /app/dist/index.js &
apid=$!
wait "$apid"
