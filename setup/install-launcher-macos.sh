#!/usr/bin/env bash
# Install or update "Matron Bridge.app", the signed launcher the macOS bridge
# service runs under (see macos/launcher/README.md).
#
#   bash setup/install-launcher-macos.sh <Matron-Bridge-x.y.z.zip | Matron Bridge.app> [options]
#
# --team-id <id>         the Apple team the app must be signed by. Required
#                        for a first install. An update without it must come
#                        from the same team as the app already installed.
# --dest <dir>           where to install (default $HOME/Applications)
# --allow-unnotarized    skip the Gatekeeper check, for a local test build
#
# The new bundle is checked (signature, bundle id, team, Gatekeeper) before
# anything is replaced, and swapped in by rename, so a failed or interrupted
# install leaves the old app in place. A running bridge keeps running on the
# old copy until its next restart.
#
# Then run setup/service.sh (once) to point the bridge service at the app.

set -euo pipefail

APP_NAME="Matron Bridge"
BUNDLE_ID="chat.matron.bridge"
EXE_NAME="matron-bridge-launcher"

die() { echo "ERROR: $*" >&2; exit 1; }

src=""
team_id=""
dest="${HOME:?}/Applications"
allow_unnotarized=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --team-id) team_id="${2:?}"; shift 2 ;;
    --dest) dest="${2:?}"; shift 2 ;;
    --allow-unnotarized) allow_unnotarized=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) [ -z "$src" ] || die "only one app or zip, please"; src="$1"; shift ;;
  esac
done

[ "$(uname -s)" = Darwin ] || die "the launcher app is for macOS only."
[ -n "$src" ] || die "usage: $0 <Matron-Bridge-x.y.z.zip | $APP_NAME.app> [--team-id <id>]"
[ "$(id -u)" -ne 0 ] || die "install the app as the user who runs the bridge, not with sudo."

work="$(mktemp -d "${TMPDIR:-/tmp}/matron-bridge-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT

case "$src" in
  *.zip)
    ditto -x -k "$src" "$work/unpacked"
    new="$work/unpacked/$APP_NAME.app"
    [ -d "$new" ] || die "$src does not contain '$APP_NAME.app' at its top level."
    ;;
  *.app|*.app/)
    [ -d "$src" ] || die "$src not found"
    new="$work/$APP_NAME.app"
    ditto "$src" "$new"
    ;;
  *) die "expected a .zip or a .app, got $src" ;;
esac

# Team identifier of a signed bundle, or empty for ad hoc / unsigned.
team_of() {
  codesign --display --verbose=2 "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p' | grep -v '^not set$' || true
}

codesign --verify --strict --deep "$new" || die "the app's signature does not verify."
got_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$new/Contents/Info.plist" 2>/dev/null || true)"
[ "$got_id" = "$BUNDLE_ID" ] || die "bundle identifier is '$got_id', expected '$BUNDLE_ID'."
[ -x "$new/Contents/MacOS/$EXE_NAME" ] || die "the app has no $EXE_NAME executable."

installed="$dest/$APP_NAME.app"
new_team="$(team_of "$new")"
expected="$team_id"
if [ -z "$expected" ] && [ -d "$installed" ]; then
  expected="$(team_of "$installed")"
fi
if [ -z "$expected" ]; then
  # Gatekeeper trusts every Developer ID team, so on a first install only an
  # explicit team stops an app signed by someone else from being accepted.
  die "first install: pass --team-id with the team you expect. This app is signed by team '${new_team:-none: ad hoc}'; check that it is yours."
fi
if [ "$new_team" != "$expected" ]; then
  die "the app is signed by team '${new_team:-none}', expected '$expected'. Permission grants are tied to the team, so a different team would lose them."
fi

if [ "$allow_unnotarized" = 1 ]; then
  echo "Skipping the Gatekeeper check (--allow-unnotarized)."
else
  /usr/sbin/spctl --assess --type execute "$new" 2>/dev/null ||
    die "Gatekeeper rejects the app (not notarised?). Use a notarised build, or --allow-unnotarized for a local test build."
fi

mkdir -p "$dest"
staged="$dest/.$APP_NAME.app.new.$$"
old="$dest/.$APP_NAME.app.old.$$"
rm -rf "$staged" "$old"
ditto "$new" "$staged"
if [ -d "$installed" ]; then
  mv "$installed" "$old"
fi
if ! mv "$staged" "$installed"; then
  [ -d "$old" ] && mv "$old" "$installed"
  die "could not move the new app into $dest; the old one is back in place."
fi
rm -rf "$old"

version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$installed/Contents/Info.plist" 2>/dev/null || echo '?')"
echo "✅ Installed $APP_NAME $version at $installed (team ${new_team:-none: ad hoc})"
echo
echo "Next:"
echo "  1. bash setup/service.sh            # points the bridge service at the app"
echo "  2. open -a \"$installed\" --args --request-permissions"
echo "     then switch on Matron Bridge under Accessibility and Screen Recording"
echo "     in System Settings ▸ Privacy & Security, and remove the old node rows."
