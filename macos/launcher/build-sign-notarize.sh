#!/usr/bin/env bash
# Build "Matron Bridge.app", sign it, and optionally notarise it.
#
#   macos/launcher/build-sign-notarize.sh --identity <identity> [options]
#
# --identity <id>        codesign identity: the 40-character SHA-1 fingerprint
#                        `security find-identity -v -p codesigning` prints, or
#                        the certificate's full name. Use the fingerprint when
#                        two certificates share a name. `-` signs ad hoc, for
#                        local testing only: macOS then ties permission grants
#                        to this exact build, so every rebuild loses them.
#                        Default: $MATRON_SIGN_IDENTITY.
# --version <x.y.z>      CFBundleShortVersionString (default 1.0.0)
# --build <n>            CFBundleVersion (default: UTC timestamp)
# --out <dir>            output directory (default macos/launcher/build)
# --notarize             submit to Apple's notary service, wait, and staple.
#                        Needs one of:
#   --keychain-profile <name>    a profile saved with
#                                `xcrun notarytool store-credentials`
#   --api-key <path.p8> --api-key-id <id> --api-issuer <uuid>
#                                an App Store Connect API key (Developer role
#                                or higher)
#
# Output: <out>/Matron Bridge.app and <out>/Matron-Bridge-<version>.zip, the
# zip being what setup/install-launcher-macos.sh installs.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Matron Bridge"
EXE_NAME="matron-bridge-launcher"

identity="${MATRON_SIGN_IDENTITY:-}"
version="1.0.0"
build="$(date -u +%Y%m%d%H%M)"
out="$HERE/build"
notarize=0
profile=""
api_key=""
api_key_id=""
api_issuer=""

die() { echo "ERROR: $*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --identity) identity="${2:?}"; shift 2 ;;
    --version) version="${2:?}"; shift 2 ;;
    --build) build="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --notarize) notarize=1; shift ;;
    --keychain-profile) profile="${2:?}"; shift 2 ;;
    --api-key) api_key="${2:?}"; shift 2 ;;
    --api-key-id) api_key_id="${2:?}"; shift 2 ;;
    --api-issuer) api_issuer="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || die "this builds a macOS app; run it on a Mac."
[ -n "$identity" ] || die "--identity is required (or set MATRON_SIGN_IDENTITY)."
case "$version" in
  *[!0-9.]*|'') die "--version must look like 1.2.3 (got '$version')" ;;
esac
case "$build" in
  *[!0-9.]*|'') die "--build must be numeric (got '$build')" ;;
esac
if [ "$notarize" = 1 ]; then
  [ "$identity" != - ] || die "an ad hoc signature cannot be notarised."
  if [ -z "$profile" ] && { [ -z "$api_key" ] || [ -z "$api_key_id" ] || [ -z "$api_issuer" ]; }; then
    die "--notarize needs --keychain-profile, or --api-key, --api-key-id and --api-issuer."
  fi
fi

echo "=== Building $EXE_NAME (arm64 + x86_64) ==="
swift build --package-path "$HERE" -c release --arch arm64 --arch x86_64
bin_dir="$(swift build --package-path "$HERE" -c release --arch arm64 --arch x86_64 --show-bin-path)"

app="$out/$APP_NAME.app"
stage="$(mktemp -d "${TMPDIR:-/tmp}/matron-bridge-app.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
staged="$stage/$APP_NAME.app"

mkdir -p "$staged/Contents/MacOS"
cp "$bin_dir/$EXE_NAME" "$staged/Contents/MacOS/$EXE_NAME"
sed -e "s/@VERSION@/$version/" -e "s/@BUILD@/$build/" "$HERE/Info.plist" > "$staged/Contents/Info.plist"
printf 'APPL????' > "$staged/Contents/PkgInfo"
plutil -lint "$staged/Contents/Info.plist" >/dev/null

echo "=== Signing with identity $identity ==="
sign_args=(--force --sign "$identity" --options runtime --entitlements "$HERE/launcher.entitlements")
# A secure timestamp is required for notarisation; ad hoc signing has none.
if [ "$identity" = - ]; then sign_args+=(--timestamp=none); else sign_args+=(--timestamp); fi
codesign "${sign_args[@]}" "$staged"
codesign --verify --strict --verbose=2 "$staged"

mkdir -p "$out"
rm -rf "$app"
mv "$staged" "$app"

zip="$out/Matron-Bridge-$version.zip"
make_zip() {
  rm -f "$zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
}
make_zip

if [ "$notarize" = 1 ]; then
  echo "=== Notarising (this waits for Apple) ==="
  if [ -n "$profile" ]; then
    xcrun notarytool submit "$zip" --keychain-profile "$profile" --wait
  else
    xcrun notarytool submit "$zip" --key "$api_key" --key-id "$api_key_id" --issuer "$api_issuer" --wait
  fi
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  # Zip again so the published zip carries the stapled ticket.
  make_zip
  /usr/sbin/spctl --assess --type execute --verbose=2 "$app"
fi

echo
echo "=== Done ==="
codesign --display --verbose=2 "$app" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Timestamp|Runtime Version)=' || true
echo "Designated requirement (what permission grants are tied to):"
codesign --display --requirements - "$app" 2>&1 | sed -n 's/^designated => /  /p'
echo
echo "App: $app"
echo "Zip: $zip"
