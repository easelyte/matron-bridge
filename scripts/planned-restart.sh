#!/usr/bin/env bash
set -uo pipefail
usage() { echo 'usage: planned-restart.sh "<reason>" [--sha <sha>] [--request-key <key>]' >&2; exit 2; }
[[ $# -gt 0 && -n "$1" ]] || usage
reason=$1; shift
sha=''; request_key=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) [[ $# -ge 2 && -n "$2" ]] || usage; sha=$2; shift 2 ;;
    --request-key) [[ $# -ge 2 && -n "$2" ]] || usage; request_key=$2; shift 2 ;;
    *) usage ;;
  esac
done
env_file=${MATRON_RESTART_ENV_FILE:-${HOME}/.matron-bridge-restart.env}
read_token() {
  [[ -e "$env_file" ]] || { echo 'bridge restarting or down, retry after back' >&2; exit 4; }
  [[ -f "$env_file" && -r "$env_file" ]] || { echo 'malformed restart token file' >&2; exit 2; }
  local raw
  raw=$(cat -- "$env_file") || { echo 'cannot read restart token file' >&2; exit 2; }
  [[ "$raw" =~ ^MATRON_RESTART_TOKEN=([a-f0-9]{64})$ ]] || { echo 'malformed restart token file' >&2; exit 2; }
  token=${BASH_REMATCH[1]}
}
read_token
client_tmp=$(mktemp -d) || exit 2
trap 'rm -rf -- "$client_tmp"' EXIT
payload=$(env -i HOME="$client_tmp" PATH="$PATH" node -e '
const [reason, sha, request_key] = process.argv.slice(1);
console.log(JSON.stringify({reason, ...(sha ? {sha} : {}), ...(request_key ? {request_key} : {})}));
' -- "$reason" "$sha" "$request_key") || exit 2
for attempt in 1 2; do
  status=$(printf 'X-Matron-Restart-Token: %s\n' "$token" | curl --silent --show-error --max-time 15 \
    -H @- -H 'Content-Type: application/json' --data "$payload" \
    "http://localhost:${MATRON_BRIDGE_API_PORT:-9802}/restart" -o "$client_tmp/response" -w '%{http_code}') \
    || { echo 'bridge restarting or down, retry after back' >&2; exit 4; }
  case "$status" in
    200) cat "$client_tmp/response"; exit 0 ;;
    401) if [[ "$attempt" == 1 ]]; then read_token; else echo 'token stale, bridge restarted; retry after back' >&2; exit 5; fi ;;
    503) echo 'retry after back' >&2; exit 6 ;;
    *) echo "restart request failed (HTTP $status)" >&2; exit 2 ;;
  esac
done
