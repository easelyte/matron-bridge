#!/bin/bash
# deploy.sh — ship the latest master to the live bridge, safely.
#
# Pull → sync deps → PREFLIGHT (verify the new code can actually boot) →
# restart. The preflight runs while the OLD process is still serving, so a
# broken deploy leaves the running bridge untouched instead of crash-looping:
# launchd's KeepAlive / systemd's Restart=always would otherwise relaunch a
# non-booting build forever (this is the exact failure mode a bare restart
# hit — pulled code that added `sharp` as a top-level import, with
# node_modules not yet synced).
#
# This is the deliberate, infrequent "ship latest" path. `restart.sh` stays as
# the dumb "just bounce the current code" bounce; it never touches deps.
#
# Works on both hosts the bridge runs on:
#   macOS  — LaunchAgent, restarted with `launchctl kickstart -k`
#   Linux  — systemd unit (setup/service-linux.sh), restarted with `systemctl`
#
# Usage:
#   ./deploy.sh            pull, install, preflight, restart, record old PID
#   ./deploy.sh --dry-run  pull, install, preflight — report readiness, NO restart

set -euo pipefail
cd "$(dirname "$0")"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }

# Which service manager owns the bridge on this host. Everything
# manager-specific — the "does the service exist?" preflight, the old-PID
# lookup and the restart itself — is behind these three functions so the
# pull/install/preflight body stays identical on both platforms.
case "$(uname -s)" in
  Darwin)
    # Label of the installed LaunchAgent, discovered rather than hardcoded. Two
    # names are in the wild: setup/service-macos.sh installs
    # "chat.matron.matron-bridge", while machines set up before the repo rename
    # still run "chat.matron.claude-matrix-bridge" — launchd never renames a
    # service just because its repo moved. Hardcoding either one breaks the
    # other half of the installs: the pull, the npm install and the whole
    # preflight succeed, then launchctl says "Could not find service" and the
    # deploy aborts with the OLD code still serving. A pull that looks like a
    # ship.
    #
    # So ask launchd which of them it actually has. Whichever answers is the
    # one that would be restarted.
    DOMAIN="gui/$(id -u)"
    SERVICE=""
    for candidate in chat.matron.matron-bridge chat.matron.claude-matrix-bridge; do
      if launchctl print "$DOMAIN/$candidate" >/dev/null 2>&1; then
        SERVICE="$candidate"
        break
      fi
    done
    TARGET="$DOMAIN/${SERVICE:-chat.matron.matron-bridge}"

    service_exists() { launchctl print "$TARGET" >/dev/null 2>&1; }
    service_pid()    { launchctl print "$TARGET" 2>/dev/null | awk -F'= ' '/^[[:space:]]*pid = /{print $2; exit}' || true; }
    # kickstart -k kills the running instance; KeepAlive relaunches it on the
    # freshly-synced code.
    service_restart() { launchctl kickstart -k "$TARGET"; }
    VERIFY_HINT="launchctl print $TARGET | grep 'pid ='"
    ;;
  Linux)
    # setup/service-linux.sh installs a system-level unit, so restarting needs
    # root. Non-interactive sudo only: this script is usually run from inside a
    # bridge session, where a password prompt would hang forever.
    SUDO=""
    if [ "$(id -u)" -ne 0 ]; then
      sudo -n true 2>/dev/null \
        || fail "restarting matron-bridge needs passwordless sudo for systemctl (sudo -n failed)"
      SUDO="sudo -n"
    fi
    TARGET="matron-bridge"

    service_exists() { systemctl cat "$TARGET" >/dev/null 2>&1; }
    service_pid()    { systemctl show "$TARGET" -p MainPID --value 2>/dev/null || true; }
    # --no-block: hand the restart to systemd and return at once. A blocking
    # restart never returns to us — the process running this script is
    # typically a child of the bridge being restarted, so it dies mid-wait
    # and the closing messages are lost. systemd (PID 1) finishes the job
    # either way.
    service_restart() { $SUDO systemctl restart --no-block "$TARGET"; }
    VERIFY_HINT="systemctl show $TARGET -p MainPID -p ActiveState"
    ;;
  *)
    fail "unsupported platform: $(uname -s) — deploy.sh knows launchd (macOS) and systemd (Linux)"
    ;;
esac

# 1. Pull latest master. --ff-only: never rewrite or diverge the live tree.
step "git pull --ff-only origin master"
git pull --ff-only origin master

# 2. Sync dependencies. Idempotent — a ~1s no-op when already in sync, and the
#    one step a bare restart can't do. This is where sharp/native deps land.
step "npm install"
npm install --no-audit --no-fund
# npm 10 strips the `libc` fields npm 11 wrote into the committed lockfile,
# leaving ` M package-lock.json` behind; a fleet updater
# script) then skips this checkout as locally modified on
# every later pass (tracker #3956). The lockfile is the repo's, so put it back.
if [ -f package-lock.json ] && ! git checkout -q -- package-lock.json; then
  fail "could not restore package-lock.json after npm install — refusing to restart on a modified lockfile"
fi

# 3. PREFLIGHT — prove the new code boots BEFORE we kill the working process.
step "preflight (old process still serving)"

echo "  - declared deps all installed?"
if ! npm ls --omit=dev >/tmp/matron-deploy-npmls.txt 2>&1; then
  # npm ls also exits non-zero for benign 'extraneous' packages; only a
  # genuinely missing/unmet/invalid dep is a boot blocker.
  if grep -qiE 'missing|invalid|unmet' /tmp/matron-deploy-npmls.txt; then
    grep -iE 'missing|invalid|unmet' /tmp/matron-deploy-npmls.txt >&2
    fail "a declared dependency is missing/invalid — 'npm install' did not resolve it"
  fi
fi

echo "  - syntax of every entrypoint (npm run check)?"
npm run check >/dev/null || fail "syntax check failed — see 'npm run check'"

echo "  - native bindings actually load, import chain resolves?"
# The definitive test for the sharp class of failure: node --check parses but
# never resolves imports, so only an actual import exercises the module graph
# and the native .node binding. index.js pulls sharp via lib/inline-image.js.
node --input-type=module \
  -e "await import('sharp'); await import('./lib/inline-image.js')" \
  || fail "the new code cannot import its dependencies — refusing to restart a broken build"

echo "  - the service we are about to restart exists?"
service_exists \
  || fail "no such service: $TARGET — nothing would be restarted, and the old code would keep serving"

echo "  preflight OK — the new code imports and boots"

if [ "$DRY_RUN" = "1" ]; then
  step "--dry-run: readiness verified, bridge NOT restarted"
  exit 0
fi

# 4. Restart via the service manager. Record the old PID so the restart can
#    be verified afterwards (the restart kills the process hosting whatever
#    invoked us, so we can't reliably check the new PID here).
OLD_PID=$(service_pid)
echo "${OLD_PID:-none}" > /tmp/matron-deploy-oldpid
step "restart $TARGET  (old PID: ${OLD_PID:-none})"
service_restart

echo "Restart requested. Old PID was ${OLD_PID:-none} (saved to /tmp/matron-deploy-oldpid)."
echo "Verify: $VERIFY_HINT — the PID should differ and stay up."
