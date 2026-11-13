import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Bypass sessions need the permission-card hook; auto-mode sessions already
// use upstream's permission gate and must not be gated twice.
export function withForkPrintSettings(base, { bypass } = {}) {
  if (!bypass) return base;
  return {
    ...base,
    hooks: {
      ...(base?.hooks || {}),
      PreToolUse: [
        ...(base?.hooks?.PreToolUse || []),
        {
          matcher: 'mcp__.*',
          hooks: [{ type: 'command', command: path.join(BRIDGE_DIR, 'hooks', 'permission-decision.sh'), timeout: 1800 }],
        },
      ],
    },
  };
}
