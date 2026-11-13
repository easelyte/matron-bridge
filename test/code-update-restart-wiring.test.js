import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORK_HOLD_MAX_MS, workHold, liveWorkChildren, parseProcessTable, holdKind } from '../lib/work-hold.js';
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

  it('watches the checkout index.js runs from, and is off without a reflog or when disabled', () => {
    expect(fn).toMatch(/if \(!CODE_UPDATE_RESTART\) \{/);
    expect(fn).toMatch(/resolveGitDir\(__dirname\)/);
    expect(fn).toMatch(/readHeadReflog\(gitDir\)/);
    expect(fn).toMatch(/defaultPreflight\(__dirname\)/);
    expect(index).toMatch(/const CODE_UPDATE_RESTART = codeUpdateRestartEnabled\(process\.env\.MATRON_CODE_UPDATE_RESTART\)/);
  });

  it('never forces a mid-turn restart unless the box opts in (ship-1, 2026-10-03)', () => {
    // 0 = never; the env is the only way to turn forcing on.
    expect(index).toMatch(/const CODE_UPDATE_FORCE_AFTER_MS = parseCodeUpdateMsOrOff\(process\.env\.MATRON_CODE_UPDATE_FORCE_AFTER_MS, CODE_UPDATE_FORCE_AFTER_DEFAULT_MS\)/);
    expect(fn).toMatch(/forceAfterMs: CODE_UPDATE_FORCE_AFTER_MS,/);
    expect(fn).toMatch(/warnEveryMs: CODE_UPDATE_WARN_EVERY_MS,/);
    expect(index).not.toMatch(/MAX_DEFER/);
  });

  it('counts a live session as holding when it is busy (the flag /sessions reports and restart_session parks on), has a background work child, or has a running subagent', () => {
    expect(fn).toContain('busySessions: () => sessionsHoldingRestart().holders.length,');
    const holdStart = index.indexOf('function sessionsHoldingRestart(');
    const holdFn = index.slice(holdStart, index.indexOf('\n}\n', holdStart) + 3);
    expect(holdFn).toMatch(/filter\(s => s\.alive\)/);
    expect(holdFn).toContain('const last = ageCap ? handoffIdleSince(s) : now;');
    expect(holdFn).toContain('sessionWorkHold(s, last, now, table)');
    expect(holdFn).toContain("const hold = s.busy\n      ? { reason: 'turn in progress' }");
    expect(holdFn).toContain('workHold({ subagentCount: s.subagentConvos?.runningCount() ?? 0, idleSince: last, now })');
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
    expect(boot).toMatch(/const stamp = takeSelfRestartStamp\(SELF_RESTART_STAMP_FILE\);\n\s*if \(!stale\.length\) return;/);
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
    expect(fnCarry).toMatch(/await journalRouteTextToSession\(target, text, \{ causes, keepRestartBudget \}\);/);
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
    const make = new Function('sessions', 'Date', 'workHold', 'liveWorkChildren', 'parseProcessTable', 'handoffIdleSince', 'holdKind', 'execFileSync', 'processTableCommand', 'stripJournalCreds', 'debug', 'MCP_SERVER_SIGNATURES', `
      ${functionSource('readProcessTable')}
      ${functionSource('sessionChildPid')}
      ${functionSource('sessionWorkHold')}
      ${functionSource('sessionsHoldingRestart')}
      return { busySessions: () => sessionsHoldingRestart().holders.length, holders: options => sessionsHoldingRestart(options), readProcessTable };
    `);
    return make(new Map([['room', session]]), { now: () => now }, workHold, liveWorkChildren, parseProcessTable, handoffIdleSince, holdKind, execFileSync, () => ({ file: 'ps', args: [] }), () => ({}), () => {}, []);
  }

  it('holds a running turn even at or beyond the eight-hour age cap', () => {
    for (const age of [WORK_HOLD_MAX_MS - 1, WORK_HOLD_MAX_MS, WORK_HOLD_MAX_MS + 1]) {
      expect(harness({ busy: true, age, tableOutput: '' }).busySessions()).toBe(1);
    }
    expect(harness({ busy: true, alive: false }).busySessions()).toBe(0);
  });

  it('names what holds, and an uncapped call keeps background work and subagents past the age cap', () => {
    const idle = { busy: false, age: WORK_HOLD_MAX_MS + 1 };
    expect(harness(idle).holders().holders).toEqual([]);
    expect(harness(idle).holders({ ageCap: false }).holders.map(h => h.why)).toEqual(['children']);
    expect(harness({ ...idle, subagentCount: 1, tableOutput: '' }).holders({ ageCap: false }).holders.map(h => h.why)).toEqual(['subagents']);
    expect(harness({ busy: true }).holders().holders.map(h => h.why)).toEqual(['busy']);
    expect(harness({ unreadable: true }).holders().unreadable).toBe(true);
    expect(harness().holders().unreadable).toBe(false);
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
