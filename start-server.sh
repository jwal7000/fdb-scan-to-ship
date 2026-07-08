#!/bin/bash
EXISTING=$(lsof -ti TCP:3000 2>/dev/null)
if [ -n "$EXISTING" ]; then
  echo "[start-server] Clearing port 3000 (PID $EXISTING)"
  kill -9 $EXISTING 2>/dev/null
  sleep 1
fi
exec node /Users/openclaw-user/.openclaw/workspace/scan-to-ship/server.js
