#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SCOPE="${SCOPE:-user}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found. Install Node.js 22+ (e.g. 'brew install node@22')." >&2
  exit 1
fi

if [ ! -f "$REPO_DIR/.env" ]; then
  echo "ERROR: $REPO_DIR/.env not found. Run setup/install.sh first." >&2
  exit 1
fi

case "$SCOPE" in
  user)
    # Under sudo, $HOME is still the invoking user's but `id -u` is 0, so
    # bootstrap targets gui/0 (fails with error 125) and the plists and
    # LaunchAgents dir are left owned by root.
    if [ "$(id -u)" -eq 0 ]; then
      echo "ERROR: user-scope install must not run as root." >&2
      echo "Re-run without sudo:       bash $0" >&2
      echo "or for a boot-time daemon: sudo SCOPE=system bash $0" >&2
      exit 1
    fi
    PLIST_DIR="$HOME/Library/LaunchAgents"
    LOG_DIR="$HOME/Library/Logs"
    TARGET="gui/$(id -u)"
    ;;
  system)
    if [ "$(id -u)" -ne 0 ]; then
      echo "ERROR: SCOPE=system requires sudo." >&2
      echo "Re-run as: sudo SCOPE=system $0" >&2
      exit 1
    fi
    PLIST_DIR="/Library/LaunchDaemons"
    LOG_DIR="/var/log"
    TARGET="system"
    ;;
  *)
    echo "ERROR: SCOPE must be 'user' or 'system' (got: $SCOPE)" >&2
    exit 1
    ;;
esac

# MATRON_SERVICE_WRITE_ONLY=<dir>: write the plists into <dir> and stop,
# without touching launchd. For checking what would be installed.
WRITE_ONLY="${MATRON_SERVICE_WRITE_ONLY:-}"
if [ -n "$WRITE_ONLY" ]; then
  PLIST_DIR="$WRITE_ONLY"
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"

BRIDGE_LABEL="chat.matron.matron-bridge"
VIEWER_LABEL="chat.matron.matron-bridge-viewer"
BRIDGE_PLIST="$PLIST_DIR/$BRIDGE_LABEL.plist"
VIEWER_PLIST="$PLIST_DIR/$VIEWER_LABEL.plist"

# "Matron Bridge.app" (macos/launcher/README.md). When it is installed, the
# bridge service runs under it, so macOS shows "Matron Bridge" for
# Accessibility and Screen Recording instead of node. The app starts
# run-named-node as its child and stays its parent, so launchd still watches
# the service's process and the exit status passes through: KeepAlive and the
# code-update restart (exit 75) work as before. Never `open -a` it from the
# plist: open returns at once, and launchd would lose the process.
# Only for SCOPE=user: permissions are per user and need the GUI session.
# Without the app, or with MATRON_LAUNCHER=0, the plist is the plain one.
LAUNCHER_APP="${MATRON_LAUNCHER_APP:-$HOME/Applications/Matron Bridge.app}"
LAUNCHER_BIN="$LAUNCHER_APP/Contents/MacOS/matron-bridge-launcher"
LAUNCHER_BUNDLE_ID=""
if [ "$SCOPE" = user ] && [ "${MATRON_LAUNCHER:-}" != 0 ] && [ -d "$LAUNCHER_APP" ]; then
  if [ ! -x "$LAUNCHER_BIN" ]; then
    echo "WARNING: $LAUNCHER_APP has no launcher executable; using the plain service." >&2
  elif ! codesign --verify --strict "$LAUNCHER_APP" 2>/dev/null; then
    echo "WARNING: $LAUNCHER_APP fails its signature check; using the plain service." >&2
    echo "         Reinstall it with setup/install-launcher-macos.sh." >&2
  else
    LAUNCHER_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$LAUNCHER_APP/Contents/Info.plist" 2>/dev/null || true)"
    [ -n "$LAUNCHER_BUNDLE_ID" ] || echo "WARNING: $LAUNCHER_APP has no bundle identifier; using the plain service." >&2
  fi
fi

echo "=== Installing launchd services ($SCOPE scope) ==="
echo "Repo: $REPO_DIR"
echo "Node: $NODE_BIN"
echo "Plist dir: $PLIST_DIR"
if [ -n "$LAUNCHER_BUNDLE_ID" ]; then
  echo "Bridge runs under: $LAUNCHER_APP"
fi
echo

# XML-escape a string for inclusion in plist string values.
xml_escape() {
  local s="$1"
  # bash 5.2 can treat & specially in ${var//pat/repl}; macOS bash 3.2
  # does not. Disabling the option where available gives one portable form.
  shopt -u patsub_replacement 2>/dev/null || true
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  printf '%s' "$s"
}

# Read .env and emit plist <key>/<string> pairs for every non-empty,
# non-comment KEY=VALUE line. Strips surrounding quotes from VALUE.
emit_env_keys() {
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    case "$key" in
      [A-Za-z_]*) ;;
      *) continue ;;
    esac
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    [ -z "$val" ] && continue
    # write_plist sets NODE_BIN itself, to the node this installer resolved.
    [ "$key" = NODE_BIN ] && continue
    printf '    <key>%s</key>\n    <string>%s</string>\n' \
      "$(xml_escape "$key")" "$(xml_escape "$val")"
  done < "$REPO_DIR/.env"
}

# The service runs through bin/run-named-node, which execs the script with a
# copy of node named <process-name> (e.g. $HOME/.matron/bin/matron-bridge) so a
# per-app firewall can tell Matron's processes from other Node programs.
# It execs, so launchd's KeepAlive still watches the node process itself.
# NODE_BIN tells it which node to use, as launchd's PATH may not have node.
# With the launcher app, ProgramArguments is the app's executable and the
# repo; the app runs the same run-named-node command as its child.
program_arguments() {
  local script="$1" process_name="$2" via_app="$3"
  if [ "$via_app" = 1 ]; then
    cat <<EOF
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$LAUNCHER_BIN")</string>
    <string>$(xml_escape "$REPO_DIR")</string>
  </array>
  <key>AssociatedBundleIdentifiers</key>
  <string>$(xml_escape "$LAUNCHER_BUNDLE_ID")</string>
EOF
  else
    cat <<EOF
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$(xml_escape "$REPO_DIR/bin/run-named-node")</string>
    <string>$(xml_escape "$process_name")</string>
    <string>$(xml_escape "$REPO_DIR/$script")</string>
  </array>
EOF
  fi
}

write_plist() {
  local out="$1" label="$2" script="$3" process_name="$4" stdout_log="$5" via_app="${6:-0}"
  cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
$(program_arguments "$script" "$process_name" "$via_app")
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$REPO_DIR")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$stdout_log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$stdout_log")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$HOME")/.local/bin:$(xml_escape "$HOME")/.claude/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_BIN</key>
    <string>$(xml_escape "$NODE_BIN")</string>
$(emit_env_keys)
  </dict>
</dict>
</plist>
EOF
  chmod 600 "$out"
  if ! plutil -lint "$out" >/dev/null; then
    echo "ERROR: generated plist failed plutil -lint: $out" >&2
    plutil -lint "$out" >&2 || true
    exit 1
  fi
}

reload_service() {
  local label="$1" plist="$2"
  launchctl bootout "$TARGET" "$plist" 2>/dev/null || launchctl bootout "$TARGET/$label" 2>/dev/null || true
  launchctl bootstrap "$TARGET" "$plist"
  launchctl enable "$TARGET/$label" || true
  launchctl kickstart -k "$TARGET/$label"
}

bridge_via_app=0
[ -n "$LAUNCHER_BUNDLE_ID" ] && bridge_via_app=1
write_plist "$BRIDGE_PLIST" "$BRIDGE_LABEL" "index.js" "matron-bridge" "$LOG_DIR/matron-bridge.log" "$bridge_via_app"
# The viewer drives no other app, so it stays a plain node service.
write_plist "$VIEWER_PLIST" "$VIEWER_LABEL" "viewer/start.js" "matron-viewer" "$LOG_DIR/matron-bridge-viewer.log"

if [ -n "$WRITE_ONLY" ]; then
  echo "Wrote $BRIDGE_PLIST and $VIEWER_PLIST (launchd not touched)."
  exit 0
fi

reload_service "$BRIDGE_LABEL" "$BRIDGE_PLIST"
reload_service "$VIEWER_LABEL" "$VIEWER_PLIST"

echo
echo "✅ Services installed and started ($SCOPE scope):"
echo "    Bridge plist:  $BRIDGE_PLIST"
echo "    Viewer plist:  $VIEWER_PLIST"
echo "    Bridge log:    $LOG_DIR/matron-bridge.log"
echo "    Viewer log:    $LOG_DIR/matron-bridge-viewer.log"
echo
echo "Lifecycle:"
echo "    Restart:   launchctl kickstart -k $TARGET/$BRIDGE_LABEL"
echo "    Stop:      launchctl kill TERM $TARGET/$BRIDGE_LABEL"
echo "    Status:    launchctl print $TARGET/$BRIDGE_LABEL | head -20"
echo "    Logs:      tail -f $LOG_DIR/matron-bridge.log"
echo "    Uninstall: launchctl bootout $TARGET/$BRIDGE_LABEL && rm $BRIDGE_PLIST"
echo "               launchctl bootout $TARGET/$VIEWER_LABEL && rm $VIEWER_PLIST"
echo
echo "Re-run setup/service.sh after editing .env to apply env changes."
if [ -n "$LAUNCHER_BUNDLE_ID" ]; then
  echo
  echo "The bridge runs under $LAUNCHER_APP. To list it in System Settings"
  echo "for Accessibility and Screen Recording (once):"
  echo "    open -a \"$LAUNCHER_APP\" --args --request-permissions"
fi
