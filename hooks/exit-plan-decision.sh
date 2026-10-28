#!/bin/bash
# PreToolUse hook for ExitPlanMode — gates plan-mode approval through the
# bridge instead of letting claude's TUI show a "Build? Y/n" prompt.
#
# Flow:
#   1. Hook receives the tool_use_id and plan text on stdin.
#   2. POSTs to bridge HTTP /plan-decision and BLOCKS until the bridge
#      responds (the bridge holds the response open while it waits for the
#      user's reply — see the timeout matching --max-time below).
#   3. Returns hookSpecificOutput with permissionDecision allow|deny.
#
# For any tool_name other than ExitPlanMode the hook is a no-op pass-through.

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ "$TOOL" != "ExitPlanMode" ]; then
  echo '{}'
  exit 0
fi

SID=$(echo "$INPUT" | jq -r '.session_id // empty')
TUID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
PLAN=$(echo "$INPUT" | jq -r '.tool_input.plan // empty')
PORT="${MATRON_BRIDGE_API_PORT:-9802}"

# --max-time 1800s = 30 min — generous window for the user to read & decide on
# their phone. The bridge HTTP handler should hold the response with its own
# slightly-shorter timer and reply with decision=deny on expiry so we never
# exceed this curl ceiling.
RESP=$(curl -s --max-time 1800 -X POST "http://127.0.0.1:${PORT}/plan-decision" \
  -H @"${MATRON_BRIDGE_API_HEADER_FILE:-/dev/null}" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg sid "$SID" --arg tuid "$TUID" --arg plan "$PLAN" \
        '{session_id:$sid,tool_use_id:$tuid,plan:$plan}')")

if [ -z "$RESP" ]; then
  # Bridge unreachable or timed out at curl level — default to deny so we
  # don't accidentally execute an unreviewed plan.
  jq -nc '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "bridge unreachable; plan auto-denied"}}'
  exit 0
fi

DECISION=$(echo "$RESP" | jq -r '.decision // "deny"')
REASON=$(echo "$RESP" | jq -r '.reason // ""')

jq -nc --arg d "$DECISION" --arg r "$REASON" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: $d, permissionDecisionReason: $r}}'
exit 0
