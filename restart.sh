#!/bin/bash
# Restart the matron-bridge.
# Kills any process holding the API port and any matching node processes.

cd "$(dirname "$0")"

PORT=9802

# This script is the non-systemd bounce (launchd/manual installs). Under systemd
# it is actively harmful: it kills the unit's process, systemd respawns it at
# RestartSec=5, and the nohup instance started below grabs the port first — so
# the surviving bridge is unsupervised and systemd's respawn fails to bind.
#
# Refuse whenever systemd owns the unit's lifecycle, not just while it is
# `active`: during the RestartSec hold-off after a crash the state is
# `activating` (auto-restart), and `is-active` would fail open in exactly the
# window an operator tends to reach for a manual restart. Also refuse while the
# unit is enabled-but-stopped, since a nohup bridge would block the next
# `systemctl start` from binding the port. `command -v systemctl` keeps this a
# no-op on macOS, and a missing unit reports ActiveState=inactive with an empty
# UnitFileState, so dev machines fall through unchanged.
if command -v systemctl >/dev/null 2>&1; then
  UNIT_STATE=$(systemctl show matron-bridge.service -p ActiveState -p UnitFileState 2>/dev/null)
  ACTIVE_STATE=$(printf '%s\n' "$UNIT_STATE" | sed -n 's/^ActiveState=//p')
  UNIT_FILE_STATE=$(printf '%s\n' "$UNIT_STATE" | sed -n 's/^UnitFileState=//p')
  SYSTEMD_OWNED=""
  case "$ACTIVE_STATE" in
    active|activating|reloading|refreshing|deactivating|failed) SYSTEMD_OWNED=1 ;;
  esac
  case "$UNIT_FILE_STATE" in
    enabled|enabled-runtime|linked|linked-runtime) SYSTEMD_OWNED=1 ;;
  esac
  if [ -n "$SYSTEMD_OWNED" ]; then
    echo "ERROR: matron-bridge is systemd-managed (matron-bridge.service:" \
      "ActiveState=${ACTIVE_STATE:-unknown}, UnitFileState=${UNIT_FILE_STATE:-none})." >&2
    echo "Running this script would collide with systemd's respawn on port $PORT." >&2
    echo "Use instead:  sudo systemctl restart matron-bridge" >&2
    echo "From inside a bridge session (this kills your own session's process):" >&2
    echo "  sudo systemd-run --on-active=20 --unit=bridge-restart systemctl restart matron-bridge" >&2
    exit 1
  fi
fi

echo "Stopping existing bridge processes..."

# Kill by process pattern
pkill -f 'node.*matron-bridge/index\.js' 2>/dev/null || true

# Kill anything holding our port
PORT_PID=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$PORT_PID" ]; then
  echo "Killing process on port $PORT (PID: $PORT_PID)"
  kill $PORT_PID 2>/dev/null || true
fi

# Also kill any 'node index.js' started from this directory.
# lsof works on both Linux and macOS; /proc/$pid/cwd is Linux-only.
pgrep -f "node index.js" | while read pid; do
  PROC_CWD=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')
  if [ "$PROC_CWD" = "$(pwd)" ]; then
    echo "Killing bridge PID $pid (cwd match)"
    kill $pid 2>/dev/null || true
  fi
done

sleep 2

# Verify port is free
if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "ERROR: Port $PORT still in use after cleanup"
  lsof -i :$PORT
  exit 1
fi

echo "Starting bridge..."
nohup node index.js > /tmp/matron-bridge.log 2>&1 &
NEW_PID=$!
sleep 1

if kill -0 $NEW_PID 2>/dev/null; then
  echo "Bridge started with PID: $NEW_PID"
  echo "Logs: /tmp/matron-bridge.log"
else
  echo "ERROR: Bridge failed to start. Check logs:"
  tail -20 /tmp/matron-bridge.log
  exit 1
fi
