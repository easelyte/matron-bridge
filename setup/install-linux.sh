#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_USER="${SERVICE_USER:-$(whoami)}"

echo "=== Matron Bridge - Install ==="
echo "Repo: $REPO_DIR"
echo "User: $SERVICE_USER"
echo

# Install node dependencies
echo "Installing npm dependencies..."
cd "$REPO_DIR"
npm install

# First-run configuration: guided wizard on a terminal, template fallback otherwise
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
    sed -i "s/^HMAC_SECRET=$/HMAC_SECRET=$HMAC/" "$REPO_DIR/.env"
    echo "⚠️  Edit .env to set JOURNAL_WS_URL, JOURNAL_TOKEN_FILE (or JOURNAL_TOKEN), ALLOWED_USER_IDS, etc."
    echo "    (or run 'npm run setup' from a terminal for the guided version)"
  fi
else
  echo ".env already exists — run 'npm run setup' to change it."
fi

echo
echo "Done. Next step:"
echo "  Run: sudo bash setup/service.sh"
