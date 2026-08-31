#!/bin/bash
cd /Users/openclaw-user/.openclaw/workspace/scan-to-ship
for i in 1 2 3 4; do
  /opt/homebrew/opt/node@22/bin/node "$@" && exit 0
  echo "[retry] attempt $i failed at $(date), waiting 10 min..."
  sleep 600
done
echo "[retry] all 4 attempts failed"
exit 1
