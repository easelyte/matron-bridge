import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The agent-facing instructions for room files (BRIDGE_CLAUDE.md for
// Claude sessions, BRIDGE_CODEX.md for Codex) say the same things.
const docs = {
  'BRIDGE_CLAUDE.md': readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8'),
  'BRIDGE_CODEX.md': readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8'),
};

describe('file transfer instructions', () => {
  for (const [name, text] of Object.entries(docs)) {
    it(`${name}: files go to another session with send_attachment + chat_room_id, never through git`, () => {
      expect(text).toMatch(/`send_attachment` with `chat_room_id`[^\n]*up to 10 GB/);
      expect(text).toMatch(/approval card[^\n]*returns at once[^\n]*do not wait[^\n]*resend/i);
      expect(text).toMatch(/caption[^\n]*what the file is and why[^\n]*card/i);
      expect(text).toMatch(/arrives as a local path[^\n]*inbox[^\n]*deleted after 7 days[^\n]*copy it/i);
      expect(text).toMatch(/never move database dumps or archives between boxes through git branches/i);
      expect(text).toMatch(/files do not cross into rooms with another person's agent/i);
      expect(text).not.toMatch(/branch push|handoff branch|push (it|the file|the data) to a branch/i);
    });
  }
});
