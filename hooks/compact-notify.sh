#!/bin/bash
# PreCompact hook — notifies the bridge that compaction is starting
INPUT=$(cat)
SID=$(echo "$INPUT" | jq -r '.session_id // empty')
PORT="${MATRON_BRIDGE_API_PORT:-9802}"
# The session's API token header comes from its 0600 file (never argv).
curl -s -X POST "http://127.0.0.1:${PORT}/compact-start" \
  -H @"${MATRON_BRIDGE_API_HEADER_FILE:-/dev/null}" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SID\"}" > /dev/null
exit 0
