#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.ticket-locker"
PIDFILE="$STATE/mcp.pid"
LOGFILE="$STATE/mcp.log"
PORT="${TICKET_LOCKER_PORT:-18083}"

mkdir -p "$STATE"

if [[ -f "$PIDFILE" ]]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "ALREADY_AWAKE PID=$PID PORT=$PORT"
    exit 0
  fi
  rm -f "$PIDFILE"
fi

cd "$ROOT"
npm run build --silent
nohup node build/index.js --port "$PORT" >"$LOGFILE" 2>&1 &
PID=$!
echo "$PID" >"$PIDFILE"

for _ in $(seq 1 30); do
  if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
    echo "AWAKE PID=$PID PORT=$PORT"
    echo "LOG $LOGFILE"
    exit 0
  fi
  sleep 0.5
done

echo "WAKE_FAILED PID=$PID"
tail -n 20 "$LOGFILE" || true
exit 1
