#!/bin/bash
cd "$(dirname "$0")"
# Log to a per-user directory, not a fixed name in the shared /tmp.
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/matron-bridge"
mkdir -p -m 700 "$LOG_DIR"
chmod 700 "$LOG_DIR"
# bin/run-named-node runs node as "matron-bridge" on macOS (see README,
# "Firewall-friendly process names on macOS"); elsewhere it just execs node.
exec ./bin/run-named-node matron-bridge index.js >> "$LOG_DIR/matron-bridge.log" 2>&1
