import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js (the idiom of
// test/code-update-restart-wiring.test.js — index.js has no unit harness).
// alice-mac, 2026-10-05: `!effort high` switched a print chat to interactive,
// node-pty threw "posix_spawnp failed." (its spawn-helper had lost its
// execute bit), recreateSession had already torn the print session down, and
// every resume of the room — now persisted as interactive — threw the same
// way. The chat was dead. These couplings keep it alive in print mode.
describe('interactive spawn failure falls back to print mode', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const createSession = index.slice(index.indexOf('function createSession('), index.indexOf('function reportInteractiveFallback('));
  const report = index.slice(index.indexOf('function reportInteractiveFallback('), index.indexOf('// --- Codex programmatic sessions ---'));
  const modeSwitch = index.slice(index.indexOf('function applyModeSwitch('), index.indexOf('function recreateSession('));

  it('createSession catches the interactive spawn and carries on into the print spawn', () => {
    expect(createSession).toMatch(/try \{\s*ivSession = createInteractiveSessionForRoom\(roomId, workdir, resumeSessionId, options\);\s*\} catch \(error\) \{\s*interactiveSpawnError = error;/);
    expect(createSession).toMatch(/if \(ivSession\) \{[\s\S]*?return ivSession;\s*\}/);
    // The fallback is reported on the print session, after it is in the map
    // (persistSession and sendToRoom both read sessions.get).
    expect(createSession).toMatch(/sessions\.set\(roomId, session\);[\s\S]*if \(interactiveSpawnError\) reportInteractiveFallback\(session, interactiveSpawnError, persistedMode\);\s*return session;\s*\}/);
  });

  it('marks the session, persists print mode for a known room, and tells the room why', () => {
    expect(report).toMatch(/session\._interactiveSpawnFailed = reason;/);
    expect(report).toMatch(/if \(persisted && session\.claudeSessionId\) \{\s*persistSession\([\s\S]*?\{ interactiveMode: false \}\);/);
    expect(report).toMatch(/sendToRoom\(session\.roomId,\s*`Couldn't start interactive mode/);
    expect(report).toMatch(/carries on in print mode/);
  });

  it('applyModeSwitch hands /login and /effort nothing to park on a print fallback', () => {
    expect(modeSwitch).toMatch(/if \(wantInteractive && next && !next\.iv\) return null;\s*return next;/);
  });

  it('a crashed TUI that respawns into print does not inherit the TUI-only flow state', () => {
    const from = index.indexOf('// Only onto a TUI: when the respawn fell back to print');
    const block = index.slice(from, index.indexOf('restarted.originRoomId = session.originRoomId;', from));
    expect(block).toMatch(/if \(restarted\.iv\) \{[\s\S]*_effortFlowReturnToPrint[\s\S]*_postReadySlashCommand[\s\S]*\}/);
  });
});
