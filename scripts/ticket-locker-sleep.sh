#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.ticket-locker"
PIDFILE="$STATE/mcp.pid"

if [[ -f "$PIDFILE" ]]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "$PID" 2>/dev/null || true
  fi
fi

pkill -f 'node .*build/index\\.js --port 18083' 2>/dev/null || true
pkill -f '12306-mcp --port 18083' 2>/dev/null || true
pkill -f 'ticket-locker-execute\\.js' 2>/dev/null || true

rm -f "$PIDFILE"
rm -f "$STATE/session.json" "$STATE/login-qr.jpg"

echo "SLEEPING"
echo "RESIDENT_12306_PROCESSES:"
pgrep -af '12306-mcp|ticket-locker-execute|build/index\\.js --port 18083' || echo "NONE"
