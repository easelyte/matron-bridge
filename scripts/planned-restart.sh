#!/bin/bash -p
# Planned-restart client, hardened against an ambient shell environment.
#
# Run it as `/bin/bash -p /abs/path/planned-restart.sh ...` or execute it
# directly (the shebang carries -p). `-p` is the only thing that stops the
# OUTER bash from reading BASH_ENV/ENV and importing exported functions; a
# script cannot prevent that once an outer `bash script` has started. Started
# through plain `bash script` the protection is the early re-exec and the
# `env -i` around every child, which keep the token and the request away from
# PATH lookups, imported functions and stray variables.
#
# Always give the script by path (it exits 2 for a bare name: the re-exec needs
# a path and must not search PATH for itself).
#
# Layers:
#  1. POSIXLY_CORRECT first, so special builtins (exec, unset, exit) are found
#     before any imported function of the same name.
#  2. one re-exec under `env -i` with an allowlist (HOME,
#     MATRON_RESTART_ENV_FILE, MATRON_BRIDGE_API_PORT, a canary). The re-exec
#     is recognised by a random per-exec canary passed in argv AND env, which an
#     exported variable alone cannot forge.
#  3. curl and node run as `/usr/bin/env -i <absolute binary>`; nothing is
#     looked up through PATH. The token reaches curl through a here-string, not
#     through a function-shadowable builtin.
POSIXLY_CORRECT=1
set -uo pipefail

if [[ "${1-}" != "--matron-restart-reexec=${MATRON_RESTART_CANARY:-unset}" || -z "${MATRON_RESTART_CANARY-}" ]]; then
  [[ -x /usr/bin/env && -x /bin/bash ]] || { echo 'missing /usr/bin/env or /bin/bash' >&2; exit 2; }
  # The re-exec needs a path to this file; a bare name would be looked up via PATH.
  [[ "$0" == */* ]] || { echo 'run the script by path (absolute or ./relative), not by bare name' >&2; exit 2; }
  canary="$$.${RANDOM}${RANDOM}${RANDOM}.${EPOCHREALTIME-0}"
  # The port override only counts together with an explicit token file, so an
  # ambient port can never redirect the default token.
  api_port=''
  [[ -z "${MATRON_RESTART_ENV_FILE-}" ]] || api_port=${MATRON_BRIDGE_API_PORT-}
  unset BASH_ENV ENV
  exec /usr/bin/env -i \
    HOME="${HOME-}" \
    MATRON_RESTART_ENV_FILE="${MATRON_RESTART_ENV_FILE-}" \
    MATRON_BRIDGE_API_PORT="$api_port" \
    MATRON_RESTART_CANARY="$canary" \
    /bin/bash --noprofile --norc -p "$0" "--matron-restart-reexec=$canary" "$@"
fi
shift
unset MATRON_RESTART_CANARY

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

env_file=${MATRON_RESTART_ENV_FILE:-}
port=9802
if [[ -z "$env_file" ]]; then
  [[ -n "${HOME:-}" ]] || { echo 'HOME is not set' >&2; exit 2; }
  env_file="${HOME}/.matron-bridge-restart.env"
elif [[ -n "${MATRON_BRIDGE_API_PORT:-}" ]]; then
  port=$MATRON_BRIDGE_API_PORT
fi
[[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || { echo 'invalid MATRON_BRIDGE_API_PORT' >&2; exit 2; }

node_bin=''
for candidate in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
  [[ -x "$candidate" ]] && { node_bin=$candidate; break; }
done
[[ -n "$node_bin" ]] || { echo 'node not found in a standard location' >&2; exit 2; }
[[ -x /usr/bin/curl ]] || { echo '/usr/bin/curl not found' >&2; exit 2; }

read_token() {
  [[ -e "$env_file" ]] || { echo 'bridge restarting or down, retry after back' >&2; exit 4; }
  [[ -f "$env_file" && -r "$env_file" ]] || { echo 'malformed restart token file' >&2; exit 2; }
  raw=$(<"$env_file") || { echo 'cannot read restart token file' >&2; exit 2; }
  [[ "$raw" =~ ^MATRON_RESTART_TOKEN=([a-f0-9]{64})$ ]] || { echo 'malformed restart token file' >&2; exit 2; }
  token=${BASH_REMATCH[1]}
}
read_token
payload=$(/usr/bin/env -i "$node_bin" -e '
const [reason, sha, request_key] = process.argv.slice(1);
console.log(JSON.stringify({reason, ...(sha ? {sha} : {}), ...(request_key ? {request_key} : {})}));
' -- "$reason" "$sha" "$request_key") || exit 2
for attempt in 1 2; do
  # -q first: never read ~/.curlrc. The status code is the last output line.
  out=$(/usr/bin/env -i /usr/bin/curl -q --silent --show-error --max-time 15 \
    -H @- -H 'Content-Type: application/json' --data "$payload" \
    -w '\n%{http_code}' "http://127.0.0.1:${port}/restart" <<<"X-Matron-Restart-Token: ${token}")
  curl_rc=$?
  if [[ "$curl_rc" -ne 0 ]]; then
    # Only connection-level failures (refused 7, timeout 28, empty reply 52,
    # receive error 56) mean "retry after back"; anything else is not retryable.
    case "$curl_rc" in
      7|28|52|56) echo 'bridge restarting or down, retry after back' >&2; exit 4 ;;
      *) echo "restart request failed (curl exit $curl_rc)" >&2; exit 2 ;;
    esac
  fi
  status=${out##*$'\n'}
  body=${out%$'\n'*}
  case "$status" in
    200) printf '%s' "$body"; exit 0 ;;
    401) if [[ "$attempt" == 1 ]]; then read_token; else echo 'token stale, bridge restarted; retry after back' >&2; exit 5; fi ;;
    503) echo 'retry after back' >&2; exit 6 ;;
    *) echo "restart request failed (HTTP $status)" >&2; exit 2 ;;
  esac
done
