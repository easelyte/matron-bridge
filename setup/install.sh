#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

case "$OS" in
  Linux)  exec bash "$SCRIPT_DIR/install-linux.sh" "$@" ;;
  Darwin) exec bash "$SCRIPT_DIR/install-macos.sh" "$@" ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "ERROR: this is a Git Bash / MSYS shell on Windows." >&2
    echo "On Windows, run setup\\install.ps1 from PowerShell instead." >&2
    exit 1
    ;;
  *)
    echo "ERROR: unsupported OS: $OS" >&2
    echo "Supported: Linux, Darwin (macOS)" >&2
    exit 1
    ;;
esac
