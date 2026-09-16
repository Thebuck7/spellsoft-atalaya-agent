#!/usr/bin/env bash
# Arranca / para el watcher de servicios en background (sin systemd).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$HERE/.watch.pid"
LOG_FILE="$HERE/watch-services.log"

is_running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

case "${1:-}" in
  start)
    if is_running; then echo "ya corriendo (pid $(cat "$PID_FILE"))"; exit 0; fi
    # el propio script escribe watch-services.log; aquí solo capturamos un crash
    nohup python3 "$HERE/watch-services.py" >/dev/null 2>>"$HERE/.watch-stderr.log" &
    echo $! >"$PID_FILE"
    echo "watcher arrancado (pid $!)  ·  log: $LOG_FILE"
    ;;
  stop)
    if is_running; then kill "$(cat "$PID_FILE")" && echo "detenido"; else echo "no estaba corriendo"; fi
    rm -f "$PID_FILE"
    ;;
  restart)
    "$0" stop || true; sleep 1; "$0" start
    ;;
  status)
    if is_running; then echo "corriendo (pid $(cat "$PID_FILE"))"; else echo "parado"; fi
    ;;
  logs)
    tail -n "${2:-40}" -f "$LOG_FILE"
    ;;
  *)
    echo "uso: $0 {start|stop|restart|status|logs}"; exit 1
    ;;
esac
