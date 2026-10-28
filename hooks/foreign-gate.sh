#!/bin/sh
# PreToolUse hook (every tool) the bridge adds to every Claude session for
# foreign turns (Matron-to-Matron sharing, phase 2; lib/foreign-turn.js).
#
# Asks the bridge (POST /foreign-check) about every call. The bridge's answer
# is the truth — it lives in the bridge's memory, where nothing the agent runs
# can reach it:
#   {}            not a foreign turn, or an allowed call: print nothing, so
#                 the call proceeds exactly as it would without this hook
#                 (the ordinary permission flow still applies)
#   {hookSpecificOutput … "deny" …}   print it: the call is blocked
# When the bridge cannot be reached, the flag file the bridge writes for the
# length of a foreign turn decides: present -> deny (fail closed), absent ->
# nothing. Port, room, flag path and the session's API token file are baked
# into the command at spawn, never read from the environment (a settings
# `env` block reaches hooks).
PORT=''
ROOM=''
FLAG=''
AUTH='/dev/null'
while [ $# -gt 1 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --room) ROOM="$2"; shift 2 ;;
    --flag) FLAG="$2"; shift 2 ;;
    --auth) AUTH="$2"; shift 2 ;;
    *) shift ;;
  esac
done
DENY='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"This turn was started by another person and the Matron bridge could not confirm this call is allowed, so it is blocked. Reply in the room, or ask your user with foreign_action_request."}}'
fallback() {
  if [ -z "$FLAG" ] || [ -e "$FLAG" ]; then printf '%s' "$DENY"; fi
  exit 0
}
case "$PORT" in ''|*[!0-9]*) cat >/dev/null; fallback ;; esac
if [ -z "$ROOM" ] || ! command -v curl >/dev/null 2>&1; then cat >/dev/null; fallback; fi
ENC_ROOM=$(printf '%s' "$ROOM" | od -An -tx1 | tr -d ' \n' | sed 's/\(..\)/%\1/g')
RESP=$(curl -s -f --max-time 10 -X POST -H @"$AUTH" -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${PORT}/foreign-check?room=${ENC_ROOM}" 2>/dev/null) || RESP=''
case "$RESP" in
  '{}') exit 0 ;;
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"'*) printf '%s' "$RESP"; exit 0 ;;
  *) fallback ;;
esac
