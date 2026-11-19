import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORK_HOLD_MAX_MS, workHold, liveWorkChildren, parseProcessTable } from '../lib/work-hold.js';
import { handoffIdleSince } from '../lib/pre-reap-handoff.js';

// Source-text assertions on index.js (the idiom of test/box-status-wiring.js
// — index.js has no unit harness). The self-restart onto new code only
// closes the "a bridge with an always-live session never updates" hole if
// index.js actually starts the watcher, counts mid-turn sessions the way
// the rest of the bridge does, and exits NON-zero through the ordinary
// graceful shutdown. Each coupling below fails silently if lost: the bridge
// simply keeps running old code, which is the status quo this fixes.
describe('code-update self-restart wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = index.indexOf('function startCodeUpdateWatcher()');
  const fn = index.slice(start, index.indexOf('\n}\n', start) + 3);
  const shutdown = index.slice(index.indexOf('async function gracefulShutdown('), index.indexOf("process.on('SIGINT'"));

  it('starts the watcher at the end of main(), after the carry-on cards', () => {
    const main = index.slice(index.indexOf('async function main()'), index.indexOf('main().catch'));
    expect(main).toMatch(/publishRestartCarryOnCards\(\);[\s\S]*startCodeUpdateWatcher\(\);/);
  });

  it('reads the restart gate from MATRON_RESTART_GATE_CMD, hands the watcher the fork gate, and only builds it once', () => {
    expect(fn).toMatch(/gate: restartRequests\.gate,/);
    expect(index).toMatch(/commandGate: createCommandGate\(process\.env\.MATRON_RESTART_GATE_CMD\),/);
    expect(index.match(/process\.env\.MATRON_RESTART_GATE_CMD/g)).toHaveLength(1);
  });

  it('reads the opt-in authoritative gate settings from the environment', () => {
    // The hold itself never lapses: MATRON_RESTART_GATE_MAX_HOLD_MS is not read (pinned).
    expect(fn).not.toMatch(/MATRON_RESTART_GATE_MAX_HOLD_MS/);
    expect(fn).toMatch(/notify: \(text\) =>/);
    expect(fn).toMatch(/gateNoticeAfterMs: \/\^\[1-9\]\\d\*\$\/\.test\(String\(process\.env\.MATRON_RESTART_GATE_NOTICE_AFTER_MS/);
    expect(fn).not.toMatch(/never by restart_session or the other operator restarts, which do not go through this watcher/);
    expect(fn).toMatch(/MATRON_RESTART_GATE_ON_ERROR/);
    expect(fn).toMatch(/=== 'hold' \? 'hold' : 'safe'/);
  });

  it('watches the checkout index.js runs from, and is off without a reflog or when disabled', () => {
    expect(fn).toMatch(/if \(!CODE_UPDATE_RESTART\) \{/);
    expect(fn).toMatch(/resolveGitDir\(__dirname\)/);
    expect(fn).toMatch(/readHeadReflog\(gitDir\)/);
    expect(fn).toMatch(/defaultPreflight\(__dirname\)/);
    expect(index).toMatch(/const CODE_UPDATE_RESTART = codeUpdateRestartEnabled\(process\.env\.MATRON_CODE_UPDATE_RESTART\)/);
  });

  it('never forces a mid-turn restart and never lets a gate hold lapse, whatever the env says', () => {
    // The pinned options come last, so nothing in the call can override them.
    expect(fn).toMatch(/warnEveryMs: CODE_UPDATE_WARN_EVERY_MS,/);
    expect(fn).toMatch(/\.\.\.PINNED_WATCHER_OPTIONS,\n\s*\}\);/);
    expect(fn).not.toMatch(/forceAfterMs|gateMaxMs/);
    // The opt-in is ignored, loudly, not obeyed.
    expect(index).not.toMatch(/CODE_UPDATE_FORCE_AFTER_MS =/);
    expect(index).toMatch(/MATRON_CODE_UPDATE_FORCE_AFTER_MS is ignored/);
    expect(index).not.toMatch(/MAX_DEFER/);
  });

  it('request-only mode: MATRON_CODE_UPDATE_AUTO=0 reaches the watcher, and gate mode validates it', () => {
    expect(index).toMatch(/const CODE_UPDATE_AUTO = codeUpdateRestartEnabled\(process\.env\.MATRON_CODE_UPDATE_AUTO\);/);
    expect(fn).toMatch(/autoUpdate: CODE_UPDATE_AUTO,/);
    expect(index).toMatch(/for \(const name of \['MATRON_CODE_UPDATE_RESTART', 'MATRON_CODE_UPDATE_AUTO', 'MATRON_CODE_UPDATE_AUTO_CARRY_ON'\]\)/);
  });

  it('records the restart before the exit, restores a pending request after the watcher exists, and reconciles at boot first', () => {
    expect(fn).toMatch(/beforeRestart: restartRequests\.commitRestart,/);
    expect(fn.indexOf('createCodeUpdateWatcher(')).toBeLessThan(fn.indexOf('restartRequests.restore()'));
    expect(fn.indexOf('restartRequests.restore()')).toBeLessThan(fn.indexOf('setInterval('));
    const main = index.slice(index.indexOf('async function main()'), index.indexOf('main().catch'));
    expect(main.indexOf('restartRequests.reconcileBoot()')).toBeGreaterThan(-1);
    expect(main.indexOf('restartRequests.reconcileBoot()')).toBeLessThan(main.indexOf('publishRestartCarryOnCards()'));
  });

  it('has one /restart route, on the layer, and the old routes are gone', () => {
    expect(index.match(/if \(url\.pathname === '\/restart'\) \{/g)).toHaveLength(1);
    expect(index).toMatch(/restartRequests\.handle\(\{ method: req\.method, body: data/);
    expect(index).not.toMatch(/\/restart\/dry-run|\/restart\/cancel/);
    expect(index).not.toMatch(/plannedRestart|restartLatch/);
  });

  it('the restart token is checked by the route, before any session-token check', () => {
    expect(index).toMatch(/url\.pathname === '\/restart' && req\.headers\['x-matron-restart-token'\] !== undefined/);
    expect(index.indexOf("req.headers['x-matron-restart-token'] !== undefined")).toBeLessThan(index.indexOf('if (req.method === \'GET\' && refuseApiCall(null)) return;'));
  });

  it('every input path holds the restart through the counter', () => {
    expect(index.match(/restartInputs\.begin\(\)/g).length).toBeGreaterThanOrEqual(15);
    expect(index).toMatch(/inputsInFlight: \(\) => restartInputs\.count,/);
  });

  it('counts a live session as holding when it is busy (the flag /sessions reports and restart_session parks on), has a background work child, or has a running subagent', () => {
    expect(fn).toContain('busySessions: () => sessionsHoldingRestart().holders.length + restartRequests.occupiedNow().length,');
    const holdStart = index.indexOf('function sessionsHoldingRestart() {');
    const holdFn = index.slice(holdStart, index.indexOf('\n}\n', holdStart) + 3);
    expect(holdFn).toMatch(/filter\(s => s\.alive\)/);
    expect(holdFn).toContain('const last = handoffIdleSince(s);');
    expect(holdFn).toContain('sessionWorkHold(s, last, now, table, { awaitingAnswer, queuedInput })');
    expect(holdFn).toContain("const hold = s.busy\n      ? { reason: 'turn in progress' }");
    expect(holdFn).toContain('workHold({ subagentCount: s.subagentConvos?.runningCount() ?? 0, idleSince: last, now, awaitingAnswer, queuedInput })');
    // One process-table read per poll, shared by all live sessions.
    expect(holdFn.match(/readProcessTable\(\)/g)).toHaveLength(1);
    expect(index).not.toMatch(/restartHold/);
  });

  it('restarts through gracefulShutdown with the non-zero exit code, never while already shutting down', () => {
    expect(fn).toMatch(/if \(shuttingDown\) return;/);
    expect(fn).toMatch(/gracefulShutdown\('code-update', \{ exitCode: CODE_UPDATE_EXIT_CODE \}\)/);
    expect(shutdown).toMatch(/async function gracefulShutdown\(signal, \{ exitCode = 0 \} = \{\}\)/);
    expect(shutdown).toMatch(/process\.exit\(exitCode\);/);
    expect(shutdown).not.toMatch(/process\.exit\(0\);/);
  });

  it('polls on an unref()d timer so the watcher never holds the process open', () => {
    expect(fn).toMatch(/setInterval\(\(\) => \{\n\s*watcher\.tick\(\)\.catch/);
    expect(fn).toMatch(/timer\.unref\(\)/);
  });

  it('stamps a FORCED restart with its bootId before exiting, and shrugs off a failed write', () => {
    expect(fn).toMatch(/if \(info\.forced\) \{\n\s*try \{\n\s*writeSelfRestartStamp\(SELF_RESTART_STAMP_FILE, \{ bootId: BRIDGE_BOOT_ID, sha: info\.sha, busy: info\.busy \}\);/);
    expect(fn).toMatch(/could not write \$\{SELF_RESTART_STAMP_FILE\}/);
    // The stamp is written BEFORE the shutdown that exits the process.
    expect(fn.indexOf('writeSelfRestartStamp(')).toBeLessThan(fn.indexOf("gracefulShutdown('code-update'"));
  });

  it('at boot: takes the stamp, resumes only its own interruptions by itself, cards the rest', () => {
    const boot = index.slice(index.indexOf('function publishRestartCarryOnCards()'), index.indexOf('async function main()'));
    // Taken (and removed) before the early return, so it can never outlive the boot it was meant for.
    expect(boot).toMatch(/const stamp = takeSelfRestartStamp\(SELF_RESTART_STAMP_FILE\);/);
    expect(boot.indexOf('takeSelfRestartStamp(')).toBeLessThan(boot.indexOf('if (!stale.length) return;'));
    // Resume notes are picked (and deleted) before the auto/card split, so a noted chat gets one first turn only.
    expect(boot.indexOf('takeNoteDeliveries(')).toBeGreaterThan(-1);
    expect(boot.indexOf('takeNoteDeliveries(')).toBeLessThan(boot.indexOf('selectAutoCarryOn('));
    expect(boot.indexOf('stale = noteResult.stale;')).toBeLessThan(boot.indexOf('selectAutoCarryOn('));
    expect(boot).toMatch(/selectAutoCarryOn\(stale, stamp, \{ enabled: CODE_UPDATE_AUTO_CARRY_ON \}\)/);
    // Same two gates as a card: a persisted session to resume, and a convo id a resume can address.
    // A turn another person started never carries on by itself; it gets a card that names them.
    expect(boot).toMatch(/auto\.filter\(rec => !rec\.foreignPerson && resumable\.has\(rec\.convoId\) && isResumeConvoId\(rec\.convoId\)\)/);
    expect(boot).toMatch(/rec\.foreignPerson\s*\?\s*`⚠️ The bridge restarted during a turn \$\{peerField\(rec\.foreignPerson, PEER_NAME_MAX\)\} started/);
    expect(boot).toMatch(/setTimeout\(\(\) => \{[\s\S]*?carryOnConvo\(rec\.convoId, null, null, CODE_UPDATE_AUTO_CARRY_ON_TEXT, notice\)[\s\S]*?\}, CODE_UPDATE_AUTO_CARRY_ON_DELAY_MS\)/);
    // The resume notice says why, instead of the default "session was idle" copy.
    expect(boot).toMatch(/const notice = `🔄 The bridge restarted itself onto new code[^`]*carry on automatically\.`;/);
    // The card loop skips what carries on by itself.
    expect(boot).toMatch(/for \(const rec of stale\) \{\n\s*if \(autoSet\.has\(rec\)\) continue;/);
    expect(index).toMatch(/const CODE_UPDATE_AUTO_CARRY_ON = codeUpdateAutoCarryOnEnabled\(process\.env\.MATRON_CODE_UPDATE_AUTO_CARRY_ON\)/);
  });

  it('carryOnConvo still delivers the literal "carry on" for a tap, and the marked text for the automatic path', () => {
    const fnCarry = index.slice(index.indexOf('async function carryOnConvo('), index.indexOf('async function carryOnConvo(') + 2400);
    expect(fnCarry).toMatch(/async function carryOnConvo\(convoId, session, _sendReply, text = 'carry on', resumeNotice = undefined, \{ causes = null, keepRestartBudget = false \} = \{\}\)/);
    expect(fnCarry).toMatch(/await journalRouteTextToSession\(target, text, \{ bridgeOrigin: true, causes, keepRestartBudget \}\);/);
    expect(fnCarry).toMatch(/journalResumeConvo\(convoId, resumeNotice\)/);
  });
});

// Execute only the watcher callback and its hold helpers, without booting
// index.js or touching session state on disk.
describe('code-update work holds', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const now = 1_700_000_000_000;
  const output = '10 1 claude\n11 10 sleep infinity\n';

  function functionSource(name) {
    const start = index.indexOf(`function ${name}(`);
    return index.slice(start, index.indexOf('\n}\n', start) + 3);
  }

  function harness({ busy = false, age = 0, subagentCount = 0, unreadable = false, tableOutput = output, alive = true } = {}) {
    const session = { alive, busy, lastActivityAt: now - age, proc: { pid: 10 }, subagentConvos: { runningCount: () => subagentCount } };
    const execFileSync = () => {
      if (unreadable) throw new Error('process table unavailable');
      return tableOutput;
    };
    const make = new Function('sessions', 'Date', 'workHold', 'liveWorkChildren', 'parseProcessTable', 'handoffIdleSince', 'execFileSync', 'processTableCommand', 'stripJournalCreds', 'debug', 'MCP_SERVER_SIGNATURES', `
      ${functionSource('readProcessTable')}
      ${functionSource('sessionChildPid')}
      ${functionSource('sessionWorkHold')}
      ${functionSource('sessionsHoldingRestart')}
      return { busySessions: () => sessionsHoldingRestart().holders.length, readProcessTable };
    `);
    return make(new Map([['room', session]]), { now: () => now }, workHold, liveWorkChildren, parseProcessTable, handoffIdleSince, execFileSync, () => ({ file: 'ps', args: [] }), () => ({}), () => {}, []);
  }

  it('holds a running turn even at or beyond the eight-hour age cap', () => {
    for (const age of [WORK_HOLD_MAX_MS - 1, WORK_HOLD_MAX_MS, WORK_HOLD_MAX_MS + 1]) {
      expect(harness({ busy: true, age, tableOutput: '' }).busySessions()).toBe(1);
    }
    expect(harness({ busy: true, alive: false }).busySessions()).toBe(0);
  });

  it('stops holding a background process at the existing eight-hour age cap', () => {
    expect(harness({ age: WORK_HOLD_MAX_MS - 1 }).busySessions()).toBe(1);
    expect(harness({ age: WORK_HOLD_MAX_MS }).busySessions()).toBe(0);
    expect(harness({ age: WORK_HOLD_MAX_MS + 1 }).busySessions()).toBe(0);
    expect(harness({ alive: false }).busySessions()).toBe(0);
  });

  it('holds a running subagent even with no process children, bounded by the same cap', () => {
    expect(harness({ subagentCount: 1, tableOutput: '' }).busySessions()).toBe(1);
    expect(harness({ subagentCount: 0, tableOutput: '' }).busySessions()).toBe(0);
    expect(harness({ subagentCount: 1, age: WORK_HOLD_MAX_MS, tableOutput: '' }).busySessions()).toBe(0);
    expect(harness({ subagentCount: 1, age: WORK_HOLD_MAX_MS + 1, tableOutput: '' }).busySessions()).toBe(0);
  });

  it('distinguishes a failed process-table read from a successful empty table', () => {
    const failed = harness({ unreadable: true }).readProcessTable();
    expect(Array.isArray(failed)).toBe(true);
    expect(failed).toHaveLength(0);
    expect(failed.unreadable).toBe(true);
    expect(liveWorkChildren(10, failed)).toEqual([]);
    expect(harness({ tableOutput: '' }).readProcessTable()).toEqual([]);
  });

  it('holds an idle parent with a running subagent on process-table failure, bounded by the cap', () => {
    expect(harness({ unreadable: true, subagentCount: 1 }).busySessions()).toBe(1);
    expect(harness({ unreadable: true, subagentCount: 1, age: WORK_HOLD_MAX_MS - 1 }).busySessions()).toBe(1);
    expect(harness({ unreadable: true, subagentCount: 1, age: WORK_HOLD_MAX_MS }).busySessions()).toBe(0);
    expect(harness({ unreadable: true, subagentCount: 1, age: WORK_HOLD_MAX_MS + 1 }).busySessions()).toBe(0);
  });

  it('keeps busy turns uncapped on process-table failure', () => {
    expect(harness({ unreadable: true, busy: false }).busySessions()).toBe(0);
    expect(harness({ unreadable: true, busy: true }).busySessions()).toBe(1);
    expect(harness({ unreadable: true, busy: true, age: WORK_HOLD_MAX_MS }).busySessions()).toBe(1);
    expect(harness({ unreadable: true, busy: true, age: WORK_HOLD_MAX_MS + 1 }).busySessions()).toBe(1);
  });
});
