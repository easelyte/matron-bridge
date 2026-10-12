import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createPlannedRestartState, supersedesWatcherRequests } from '../lib/planned-restart-state.js';
import { createCodeUpdateWatcher } from '../lib/code-update-restart.js';
import { evaluateQuiet } from '../lib/restart-quiet.js';
import { readProcessTableStrict } from '../lib/process-table.js';
import { createSubagentRunningStore } from '../lib/subagent-running-store.js';

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

  // Execute the actual wiring with fake resources; importing index.js boots
  // a bridge and cannot safely exercise the restart callback in a unit test.
  const startTime = process.platform === 'win32' ? '2026-01-01T00:00:00Z' : 'Thu Jan 1 00:00:00 2026';
  const group = process.platform === 'win32' ? '' : '100 100 ';
  function wiredWatcher({ session = {}, table = `101 100 ${group}${startTime} rake test`, running = [], store, plannedStore, forceAfterMs = 0 } = {}) {
    const state = { table, running, now: 1000 };
    const exec = () => { if (state.table instanceof Error) throw state.table; return state.table; };
    const restart = vi.fn();
    const addRequest = vi.fn(request => plannedStore ? plannedStore.addRequest(request) : { id: 'planned', state: 'pending' });
    const intervals = new Map();
    let watcher, busySessions;
    const context = {
      CODE_UPDATE_RESTART: true, BRIDGE_BOOT_AT: 1000, __dirname: '.',
      plannedRestartAvailable: true, plannedRestartState: plannedStore || { addRequest }, codeUpdateWatcher: undefined,
      plannedRestart: { tick: vi.fn() }, supersedesWatcherRequests,
      resolveGitDir: () => '.', readHeadReflog: () => ({ sha: 'a'.repeat(40), at: 0 }),
      sessions: new Map([['alice', { alive: true, busy: false, journalConvoId: 'alice', proc: { pid: 100 }, ...session }]]),
      evaluateQuiet, readProcessTableStrict: () => readProcessTableStrict({ exec }),
      subagentRunningStore: store || {
        list: () => { if (state.running instanceof Error) throw state.running; return state.running; },
        listStrict: () => { if (state.running instanceof Error) throw state.running; return { ok: true, records: state.running }; },
      },
      MCP_SERVER_SIGNATURES: [['server.js']], defaultPreflight: async () => ({ ok: true }),
      createCodeUpdateWatcher: (options) => {
        busySessions = options.busySessions;
        watcher = createCodeUpdateWatcher({ ...options, readHead: () => ({ sha: 'b'.repeat(40), at: 0 }),
          restart, now: () => state.now, log: () => {}, warn: () => {} });
        return watcher;
      },
      CODE_UPDATE_SETTLE_MS: 1, CODE_UPDATE_WARN_EVERY_MS: 100,
      CODE_UPDATE_FORCE_AFTER_MS: forceAfterMs, CODE_UPDATE_POLL_MS: 100,
      setInterval: (callback, ms) => {
        intervals.set(ms, callback);
        return { unref() {} };
      }, console: { log() {}, warn() {} },
    };
    runInNewContext(`${fn}\nstartCodeUpdateWatcher();`, context);
    return { state, watcher, restart, addRequest, context, intervals, count: () => busySessions(),
      probe: () => readProcessTableStrict({ exec }),
      verdict: () => evaluateQuiet({ sessions: context.sessions, readProcessTable: context.readProcessTableStrict,
        listRunningSubagents: () => state.running, mcpSignatures: context.MCP_SERVER_SIGNATURES, bootAt: 1000 }) };
  }

  it('requests a settled update at back before the next watcher poll', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-transition-'));
    const file = path.join(dir, 'state.json');
    const store = createPlannedRestartState({ file });
    try {
      store.addRequest({ reason: 'config', request_key: 'alice' });
      store.setState('restarting', { participants: ['alice'],
        verdicts: { alice: { outcome: 'resumed', at: 1 } }, stamp_written: true });
      const h = wiredWatcher({ plannedStore: store, table: '' });
      const requests = vi.spyOn(store, 'addRequest');
      const onBack = vi.spyOn(h.watcher, 'onBack');
      const start = index.indexOf('\nif (plannedRestartAvailable) {\n  let previousState;');
      const timer = index.slice(start, index.indexOf('\n\nconst apiServer', start));
      runInNewContext(timer, h.context);
      const watcherPoll = h.intervals.get(100);
      const restartPoll = h.intervals.get(1000);
      const before = fs.readFileSync(file, 'utf8');
      for (let poll = 0; poll < 3; poll++) {
        watcherPoll();
        restartPoll();
        await Promise.resolve();
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
      }
      expect(h.context.plannedRestart.tick).not.toHaveBeenCalled();
      expect(onBack).not.toHaveBeenCalled();
      requests.mockClear();
      store.setState('back');
      // Only the production restart timer runs here, before another watcher poll.
      restartPoll();
      await Promise.resolve();
      expect(store.getState()).toMatchObject({ state: 'pending', requests: [
        { origin: 'watcher', reason: 'code update', sha: 'b'.repeat(40), request_key: `code-update:${'b'.repeat(40)}` },
      ] });
      const requested = fs.readFileSync(file, 'utf8');
      store.setState('back');
      const back = fs.readFileSync(file, 'utf8');
      for (let poll = 0; poll < 3; poll++) {
        restartPoll();
        watcherPoll();
        await Promise.resolve();
        expect(fs.readFileSync(file, 'utf8')).toBe(back);
      }
      expect(JSON.parse(requested).requests).toHaveLength(1);
      expect(requests).toHaveBeenCalledTimes(1);
      expect(requests.mock.calls[0][0]).toEqual({ origin: 'watcher', reason: 'code update',
        sha: 'b'.repeat(40), request_key: `code-update:${'b'.repeat(40)}` });
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(h.restart).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts the watcher at the end of main(), after the carry-on cards', () => {
    const main = index.slice(index.indexOf('async function main()'), index.indexOf('main().catch'));
    expect(main).toMatch(/publishRestartCarryOnCards\(restartBoot\);[\s\S]*startCodeUpdateWatcher\(\);/);
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

  it('counts restart holders through the strict quiet probe', () => {
    expect(index).toMatch(/import \{[^}]*\bevaluateQuiet\b[^}]*\} from '\.\/lib\/restart-quiet\.js'/);
    expect(index).toMatch(/import \{[^}]*readProcessTableStrict[^}]*\} from '\.\/lib\/process-table\.js'/);
    expect(fn).toMatch(/listRunningSubagents: \(\) => \{\s*const result = subagentRunningStore\.listStrict\(\);\s*if \(result\.ok !== true\) throw new Error\('subagents unavailable'\);\s*return result\.records;/);
  });

  it.each([
    ['between-turn child', {}],
    ['running subagent', { table: '', running: [{ parentConvoId: 'alice', childConvoId: 'bob', addedAt: 1000 }] }],
    ['queued message', { table: '', session: { queuedMessages: ['hello'] } }],
    ['deferred control', { table: '', session: { _deferredControls: { compact: {} } } }],
    ['permission prompt', { table: '', session: { waitingForAnswer: true } }],
    ['consent prompt', { table: '', session: { pendingInteractivePrompt: {} } }],
    ['unclassified prompt', { table: '', session: { pendingUnclassifiedPrompt: true } }],
    ['missing process command', { table: Object.assign(new Error('missing'), { code: 'ENOENT' }) }],
    ['unreadable process table', { table: Object.assign(new Error('unreadable'), { code: 'EACCES' }) }],
    ['process timeout', { table: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }],
    ['subagent exception', { table: '', running: new Error('unreadable') }],
    ['missing subagents', { table: '', running: null }],
  ])('requests a planned restart once while the quiet probe holds for %s', async (_name, options) => {
    const h = wiredWatcher(options);
    if (_name === 'between-turn child') {
      expect(h.probe().ok).toBe(true);
      expect(h.verdict()).toMatchObject({ probe_error: null, holders: [{ convoId: 'alice', why: 'children' }] });
    }
    expect(h.count()).toBe(1);
    const sha = 'b'.repeat(40);
    expect(await h.watcher.tick()).toEqual({ action: 'requested', sha });
    expect(h.addRequest).toHaveBeenCalledTimes(1);
      expect(h.addRequest.mock.calls[0][0]).toEqual({ origin: 'watcher', reason: 'code update', sha, request_key: `code-update:${sha}` });
    expect(await h.watcher.tick()).toEqual({ action: 'requested', sha });
    expect(h.addRequest).toHaveBeenCalledTimes(1);
    expect(h.restart).not.toHaveBeenCalled();
    h.state.table = '';
    h.state.running = [];
    // Clearing a probe or child leaves the request for the planned gate.
    if (!options.session) {
      expect(h.count()).toBe(0);
      expect(await h.watcher.tick()).toEqual({ action: 'requested', sha });
      expect(h.addRequest).toHaveBeenCalledTimes(1);
      expect(h.restart).not.toHaveBeenCalled();
    }
  });

  it.each(['unreadable', 'corrupt'])('requests a planned restart once with a real %s subagent store', async (kind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-probe-'));
    const file = path.join(dir, 'store.json');
    const bytes = kind === 'corrupt' ? '{broken' : '{}';
    fs.writeFileSync(file, bytes);
    const read = fs.readFileSync;
    const spy = kind === 'unreadable' ? vi.spyOn(fs, 'readFileSync').mockImplementation((name, ...args) => {
      if (name === file) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return read(name, ...args);
    }) : null;
    try {
      const store = createSubagentRunningStore({ file, log: { warn() {} } });
      const h = wiredWatcher({ table: '', store });
      for (let poll = 0; poll < 2; poll++) {
        const sha = 'b'.repeat(40);
        expect(await h.watcher.tick()).toEqual({ action: 'requested', sha });
        expect(h.addRequest).toHaveBeenCalledTimes(1);
      expect(h.addRequest.mock.calls[0][0]).toEqual({ origin: 'watcher', reason: 'code update', sha, request_key: `code-update:${sha}` });
        expect(h.count()).toBe(1);
        expect(h.restart).not.toHaveBeenCalled();
      }
      expect(read(file, 'utf8')).toBe(bytes);
    } finally {
      spy?.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds one probe-error holder to all observed holders', () => {
    const h = wiredWatcher({ session: { queuedMessages: ['hello'] }, running: new Error('unreadable') });
    expect(h.probe().ok).toBe(true);
    expect(h.verdict().holders).toContainEqual({ convoId: 'alice', why: 'children' });
    expect(h.count()).toBe(3);
    h.state.running = [];
    expect(h.count()).toBe(2);
  });

  it('keeps the opt-in force boundary for between-turn work', async () => {
    const h = wiredWatcher({ forceAfterMs: 100 });
    expect(h.probe().ok).toBe(true);
    expect(h.verdict()).toMatchObject({ probe_error: null, holders: [{ convoId: 'alice', why: 'children' }] });
    expect(await h.watcher.tick()).toMatchObject({ action: 'waiting', busy: 1, waitedMs: 0 });
    h.state.now += 99;
    expect(await h.watcher.tick()).toMatchObject({ action: 'waiting', waitedMs: 99 });
    expect(h.restart).not.toHaveBeenCalled();
    h.state.now++;
    expect(await h.watcher.tick()).toMatchObject({ action: 'restart', forced: true, busy: 1, waitedMs: 100 });
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.addRequest).not.toHaveBeenCalled();
    h.state.now++;
    expect(await h.watcher.tick()).toEqual({ action: 'restarted' });
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('counts only live work, excluding restart notices and configured servers', () => {
    const work = wiredWatcher();
    expect(work.probe().ok).toBe(true);
    expect(work.verdict()).toMatchObject({ probe_error: null, holders: [{ convoId: 'alice', why: 'children' }] });
    expect(work.count()).toBe(1);
    expect(wiredWatcher({ session: { alive: false, busy: true, queuedMessages: ['hello'] } }).count()).toBe(0);
    expect(wiredWatcher({ table: '', session: { _deferredControls: { restart_notice: {} } } }).count()).toBe(0);
    const server = wiredWatcher({ table: `101 100 ${group}${startTime} node server.js\n102 101 ${group}${startTime} browser` });
    expect(server.probe().ok).toBe(true);
    expect(server.verdict()).toMatchObject({ probe_error: null, holders: [] });
    expect(server.count()).toBe(0);
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
    const boot = index.slice(index.indexOf('function publishRestartCarryOnCards('), index.indexOf('async function main()'));
    // Taken (and removed) before the early return, so it can never outlive the boot it was meant for.
    expect(boot).toMatch(/const stamp = boot \? boot\.stamp : takeSelfRestartStamp\(SELF_RESTART_STAMP_FILE\);\n\s*if \(!stale\.length\) return;/);
    expect(boot).toMatch(/selectAutoCarryOn\(stale, stamp, \{ enabled: CODE_UPDATE_AUTO_CARRY_ON \}\)/);
    // Same two gates as a card: a persisted session to resume, and a convo id a resume can address.
    expect(boot).toMatch(/auto\.filter\(rec => resumable\.has\(rec\.convoId\) && isResumeConvoId\(rec\.convoId\)\)/);
    expect(boot).toMatch(/setTimeout\(\(\) => \{[\s\S]*?carryOnConvo\(rec\.convoId, null, null, CODE_UPDATE_AUTO_CARRY_ON_TEXT, notice\)[\s\S]*?\}, CODE_UPDATE_AUTO_CARRY_ON_DELAY_MS\)/);
    // The resume notice says why, instead of the default "session was idle" copy.
    expect(boot).toMatch(/const notice = `🔄 The bridge restarted itself onto new code[^`]*carry on automatically\.`;/);
    // The card loop skips what carries on by itself.
    expect(boot).toMatch(/for \(const rec of stale\) \{\n\s*if \(autoSet\.has\(rec\)\) continue;/);
    expect(index).toMatch(/const CODE_UPDATE_AUTO_CARRY_ON = codeUpdateAutoCarryOnEnabled\(process\.env\.MATRON_CODE_UPDATE_AUTO_CARRY_ON\)/);
  });

  it('carryOnConvo still delivers the literal "carry on" for a tap, and the marked text for the automatic path', () => {
    const fnCarry = index.slice(index.indexOf('async function carryOnConvo('), index.indexOf('async function carryOnConvo(') + 2400);
    expect(fnCarry).toMatch(/async function carryOnConvo\(convoId, session, _sendReply, text = 'carry on', resumeNotice = undefined\)/);
    expect(fnCarry).toMatch(/await journalRouteTextToSession\(target, text\);/);
    expect(fnCarry).toMatch(/journalResumeConvo\(convoId, resumeNotice\)/);
  });

  it('is in the syntax-check script like every other lib', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.check).toMatch(/node --check lib\/code-update-restart\.js/);
  });
});
