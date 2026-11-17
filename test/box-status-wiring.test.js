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
  const fn = index.slice(index.indexOf('function publishBoxStatus('), index.indexOf('function publishBoxStatus(') + 2600);

  it('sends a box_status op built from the same capacity thunks as the recent_folders reply', () => {
    expect(fn).toMatch(/if \(!JOURNAL_ENABLED\) return false;/);
    expect(fn).toMatch(/buildActivity\(\{ sessions, persisted: loadPersistedSessions\(\) \}\)/);
    expect(fn).toMatch(/buildLimits\(usageLimitsCache, codexLimits\.cache\)/);
    expect(fn).toMatch(/buildDisk\(\{ path: DEFAULT_WORKDIR \}\)/);
    expect(fn).toMatch(/getAccountEmail\(\)/);
    expect(fn).toMatch(/journalPublisher\.sendRoomOp\(\{\n\s*op: 'box_status',/);
    // Blocks are omitted, never sent null: the journal rejects a report with
    // no valid block, and a null block would be "malformed", not "absent".
    expect(fn).toMatch(/\.\.\.\(activity \? \{ activity \} : \{\}\)/);
    expect(fn).toMatch(/\.\.\.\(accountEmail \? \{ account: \{ email: accountEmail \} \} : \{\}\)/);
    expect(fn).toMatch(/if \(!activity && !limits && !disk && !accountEmail && !vitals && !defaults && !restart\) return false;/);
    // Host CPU/RAM ride the same report (omitted until both readings exist).
    expect(fn).toMatch(/vitals = boxVitals\(\)/);
    expect(fn).toMatch(/\.\.\.\(vitals \? \{ vitals \} : \{\}\)/);
    // This box's effective defaults for new sessions (agent_boxes, the
    // spawn consent card), from the same resolvers a start uses.
    expect(fn).toMatch(/const \{ agent, source \} = defaultAgentInfo\(\);/);
    expect(fn).toMatch(/\.\.\.\(defaults \? \{ defaults \} : \{\}\)/);
    expect(fn).toContain('...(restart ? { restart } : {}),');
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
    expect(shutdown).toMatch(/publishBoxStatus\('shutdown'\);[\s\S]*?await journalPublisher\.flush\(\{ timeoutMs: FLUSH_TIMEOUT_MS \}\);[\s\S]*?process\.exit\(exitCode\);/);
  });

  it('feeds Codex lines from the account reader, only where Codex runs, on the Claude throttle', () => {
    const block = index.slice(index.indexOf('const codexLimits = createCodexLimitsRefresher('), index.indexOf('const codexLimits = createCodexLimitsRefresher(') + 700);
    expect(block).toMatch(/read: \(\) => codexAccountReader\.read\(DEFAULT_WORKDIR\)/);
    expect(block).toMatch(/available: \(\) => detectCodexBinary\(\)/);
    expect(block).toMatch(/refreshMs: LIMITS_REFRESH_MS/);
    expect(block).toMatch(/onFresh: \(\) => publishBoxStatus\('codex limits refresh'\)/);
    // Claude cache: throttle on attemptedAt, as_of (fetchedAt) only on success.
    const claudeRefresh = index.slice(index.indexOf('function refreshUsageLimits('), index.indexOf('function refreshUsageLimits(') + 1600);
    expect(claudeRefresh).toMatch(/Date\.now\(\) - usageLimitsCache\.attemptedAt < LIMITS_REFRESH_MS/);
    expect(claudeRefresh).toMatch(/if \(parsed\.ok\) \{\n\s*usageLimitsCache\.lines = parsed\.lines;\n\s*usageLimitsCache\.fetchedAt = usageLimitsCache\.attemptedAt;/);
    expect(claudeRefresh.match(/usageLimitsCache\.fetchedAt =/g)).toHaveLength(1);
    const refresh = index.slice(index.indexOf('function refreshUsageLimits('), index.indexOf('function refreshUsageLimits(') + 600);
    expect(refresh).toMatch(/if \(!JOURNAL_ENABLED\) return null;[\s\S]*?refreshCodexLimits\(\);/);
    // The recent_folders reply carries the same merged limits as box_status.
    expect(index).toMatch(/getLimits: \(\) => \{ refreshUsageLimits\(DEFAULT_WORKDIR\); return buildLimits\(usageLimitsCache, codexLimits\.cache\); \}/);
  });

  it('re-publishes on an unref\'d 5-minute heartbeat that shutdown clears', () => {
    expect(index).toMatch(/_boxStatusRepublishHandle = setInterval\(\(\) => publishBoxStatus\('heartbeat'\), BOX_STATUS_REPUBLISH_MS\);\n\s*if \(typeof _boxStatusRepublishHandle\.unref === 'function'\) _boxStatusRepublishHandle\.unref\(\);/);
    const shutdownStart = index.indexOf('async function gracefulShutdown(');
    const shutdown = index.slice(shutdownStart, index.indexOf('\n}\n', shutdownStart) + 2);
    expect(shutdown).toMatch(/clearInterval\(_boxStatusRepublishHandle\)/);
  });

  it('follows the CPU sampler with a vitals-only box_status, sent only when due', () => {
    const vitalsFn = index.slice(index.indexOf('function publishBoxVitals('), index.indexOf('function publishBoxVitals(') + 900);
    expect(vitalsFn).toMatch(/if \(!JOURNAL_ENABLED\) return false;/);
    expect(vitalsFn).toMatch(/boxVitalsDue\(lastBoxVitalsSent, vitals, now,/);
    expect(vitalsFn).toMatch(/sendRoomOp\(\{ op: 'box_status', vitals \}\)/);
    // Remembered only once the frame went out, so a dropped one is retried.
    expect(vitalsFn).toMatch(/if \(sent\) lastBoxVitalsSent = /);
    expect(index).toMatch(/startCpuSampler\(HOST_VITALS_SAMPLE_MS, publishBoxVitals\)/);
    expect(index).toMatch(/HOST_VITALS_DELTA_PCT \|\| '8'/);
    expect(index).toMatch(/HOST_VITALS_HEARTBEAT_MS \|\| '45000'/);
  });
});
