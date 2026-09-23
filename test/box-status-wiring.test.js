import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js (same idiom as test/items-wiring.test.js
// — index.js has no unit harness): the journal-resident box status
// (matron-journal #82) only works if this bridge actually reports itself, at
// the three moments that matter, with the same blocks the recent_folders
// reply carries. Each coupling below fails silently if lost — a box that
// never reports simply shows no usage in every client.
describe('box status wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const fn = index.slice(index.indexOf('function publishBoxStatus('), index.indexOf('function publishBoxStatus(') + 1600);

  it('sends a box_status op built from the same capacity thunks as the recent_folders reply', () => {
    expect(fn).toMatch(/if \(!JOURNAL_ENABLED\) return false;/);
    expect(fn).toMatch(/buildActivity\(\{ sessions, persisted: loadPersistedSessions\(\) \}\)/);
    expect(fn).toMatch(/buildLimits\(usageLimitsCache\)/);
    expect(fn).toMatch(/buildDisk\(\{ path: DEFAULT_WORKDIR \}\)/);
    expect(fn).toMatch(/getAccountEmail\(\)/);
    expect(fn).toMatch(/journalPublisher\.sendRoomOp\(\{\n\s*op: 'box_status',/);
    // Blocks are omitted, never sent null: the journal rejects a report with
    // no valid block, and a null block would be "malformed", not "absent".
    expect(fn).toMatch(/\.\.\.\(activity \? \{ activity \} : \{\}\)/);
    expect(fn).toMatch(/\.\.\.\(accountEmail \? \{ account: \{ email: accountEmail \} \} : \{\}\)/);
    expect(fn).toMatch(/if \(!activity && !limits && !disk && !accountEmail\) return false;/);
  });

  it('reports on every hello_ok, after a successful usage-limits refresh, and first thing at shutdown', () => {
    const reconnect = index.slice(index.indexOf('function handleJournalReconnect()'), index.indexOf('function publishBoxStatus('));
    expect(reconnect).toMatch(/journalOnReconnect\(\);\n[\s\S]*?publishBoxStatus\('reconnect'\);/);
    const refresh = index.slice(index.indexOf('function refreshUsageLimits('), index.indexOf('function refreshUsageLimits(') + 1400);
    expect(refresh).toMatch(/if \(parsed\.ok\) \{\n\s*usageLimitsCache\.lines = parsed\.lines;[\s\S]*?publishBoxStatus\('limits refresh'\);/);
    const shutdownStart = index.indexOf('async function gracefulShutdown(');
    const shutdown = index.slice(shutdownStart, index.indexOf('\n}\n', shutdownStart) + 2);
    // Before the sessions are killed, so `activity` still describes what ran.
    expect(shutdown).toMatch(/publishBoxStatus\('shutdown'\);\n\s*stopCpuSampler\(\);\n\s*for \(const \[, session\] of sessions\) \{\n\s*killSession\(session\);/);
    // ...and the publisher flush that waits for the room-op write to be
    // confirmed (lib/journal-publisher.js sendRoomOp/flush) still runs after
    // it, before process.exit — otherwise the report races the exit.
    expect(shutdown).toMatch(/publishBoxStatus\('shutdown'\);[\s\S]*?await journalPublisher\.flush\(\{ timeoutMs: FLUSH_TIMEOUT_MS \}\);[\s\S]*?process\.exit\(0\);/);
  });
});
