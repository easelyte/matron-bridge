#!/bin/bash
# PreToolUse hook for gated MCP tools. Relays only tool identity to the bridge
# and blocks until the operator decides whether the tool may run.

INPUT=$(cat)

# Kill switch: when permission cards are disabled, leave Claude's existing
# permission behavior unchanged.
if [ -z "${MATRON_PERMISSION_CARDS:-}" ]; then
  echo '{}'
  exit 0
fi

deny_unreachable() {
  local reason="$1"

  jq -nc --arg tuid "${TUID:-}" --arg reason "$reason" \
    '{tool_use_id:$tuid,decision:"deny",source:"unreachable",reason:$reason}' >&2
  jq -nc --arg reason "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

if ! printf '%s' "$INPUT" | jq -e 'type == "object"' >/dev/null 2>&1; then
  deny_unreachable 'invalid hook input'
fi

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
TUID=$(printf '%s' "$INPUT" | jq -r '.tool_use_id // empty')
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
PORT="${MATRON_BRIDGE_API_PORT:-9802}"
BODY=$(jq -nc --arg sid "$SID" --arg tuid "$TUID" --arg tool "$TOOL" \
  '{session_id:$sid,tool_use_id:$tuid,tool_name:$tool}')

if ! CURL_OUTPUT=$(curl -q -s --noproxy '*' --max-time 1740 -X POST \
  "http://127.0.0.1:${PORT}/permission-decision" \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  --write-out '\n%{http_code}'); then
  deny_unreachable 'bridge unreachable or timed out'
fi

HTTP_STATUS="${CURL_OUTPUT##*$'\n'}"
RESP="${CURL_OUTPUT%$'\n'*}"
if [[ ! "$HTTP_STATUS" =~ ^2[0-9]{2}$ ]]; then
  deny_unreachable "bridge returned HTTP status ${HTTP_STATUS}"
fi

if [ -z "$RESP" ]; then
  deny_unreachable 'bridge returned an empty response'
fi

if ! printf '%s' "$RESP" | jq -e \
  'type == "object" and (.decision == "allow" or .decision == "deny")' \
  >/dev/null 2>&1; then
  deny_unreachable 'bridge returned an invalid response'
fi

DECISION=$(printf '%s' "$RESP" | jq -r '.decision')
REASON=$(printf '%s' "$RESP" | jq -r 'if .reason == null then "" else (.reason | tostring) end')

jq -nc --arg decision "$DECISION" --arg reason "$REASON" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$decision,permissionDecisionReason:$reason}}'
exit 0
