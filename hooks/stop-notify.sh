#!/bin/bash
# Stop hook — notifies the bridge that an assistant turn has finished.
# Mirrors the shape of hooks/compact-notify.sh.
INPUT=$(cat)
SID=$(echo "$INPUT" | jq -r '.session_id // empty')
TX=$(echo "$INPUT" | jq -r '.transcript_path // empty')
PORT="${MATRON_BRIDGE_API_PORT:-9802}"
# The session's API token header comes from its 0600 file (never argv). A
# missing file is reported on stderr; the bridge then refuses the call (401).
AUTH="${MATRON_BRIDGE_API_HEADER_FILE:-}"
if [ -z "$AUTH" ] || [ ! -r "$AUTH" ] || [ ! -s "$AUTH" ]; then
  AUTH_PROBLEM="matron-bridge: this session's bridge token file ${AUTH:-(MATRON_BRIDGE_API_HEADER_FILE is not set)} is missing, unreadable or empty, so the bridge refuses this hook's call (401 Missing or unknown bridge session token). A /restart of this session re-mints it."
  echo "$AUTH_PROBLEM" >&2
  AUTH=/dev/null
fi
curl -s --max-time 5 -X POST "http://127.0.0.1:${PORT}/turn-end" \
  -H @"$AUTH" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg sid "$SID" --arg tx "$TX" '{session_id:$sid,transcript_path:$tx}')" > /dev/null
exit 0
