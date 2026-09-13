#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_USER="${SERVICE_USER:-$(whoami)}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      echo "Usage: setup/install-macos.sh"
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      echo "Usage: setup/install-macos.sh" >&2
      exit 64
      ;;
  esac
done

echo "=== Matron Bridge - Install (macOS) ==="
echo "Repo: $REPO_DIR"
echo "User: $SERVICE_USER"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. Install Node.js 22+ (e.g. 'brew install node@22')." >&2
  exit 1
fi

echo "Installing npm dependencies..."
cd "$REPO_DIR"
npm install

if [ ! -f "$REPO_DIR/.env" ]; then
  # Both stdin AND stdout must be a terminal: the wizard refuses otherwise
  # (readline only masks the hidden token in terminal mode), and under set -e
  # that refusal would skip the template fallback and leave no .env at all.
  if [ -t 0 ] && [ -t 1 ]; then
    node "$SCRIPT_DIR/wizard.mjs"
  else
    echo "Creating .env from .env.example (no terminal for the setup wizard)..."
    cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
    chmod 600 "$REPO_DIR/.env"
    HMAC=$(openssl rand -hex 32)
    # BSD sed requires an explicit empty backup-suffix argument after -i.
    sed -i '' "s/^HMAC_SECRET=$/HMAC_SECRET=$HMAC/" "$REPO_DIR/.env"
    sed -i '' "s|^DEFAULT_WORKDIR=.*$|DEFAULT_WORKDIR=$HOME|" "$REPO_DIR/.env"
    echo "⚠️  Edit .env to set JOURNAL_WS_URL, JOURNAL_TOKEN_FILE (or JOURNAL_TOKEN), ALLOWED_USER_IDS, etc."
    echo "    (or run 'npm run setup' from a terminal for the guided version)"
  fi
else
  echo ".env already exists — run 'npm run setup' to change it."
  chmod 600 "$REPO_DIR/.env"
fi

echo
echo "Done. Next steps:"
echo "  Run: setup/service.sh                       # user-scoped LaunchAgent"
echo "   or: sudo SCOPE=system setup/service.sh      # system-wide LaunchDaemon"
