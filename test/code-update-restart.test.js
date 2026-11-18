import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RESTART_EXIT_CODE,
  DEFAULT_SETTLE_MS,
  DEFAULT_WARN_EVERY_MS,
  DEFAULT_FORCE_AFTER_MS,
  parseMsOrOff,
  parseMs,
  restartEnabled,
  resolveGitDir,
  readHeadReflog,
  defaultPreflight,
  createCommandGate,
  gateEnv,
  createCodeUpdateWatcher,
  AUTO_CARRY_ON_TEXT,
  autoCarryOnEnabled,
  writeSelfRestartStamp,
  takeSelfRestartStamp,
  selectAutoCarryOn,
} from '../lib/code-update-restart.js';

// A bridge restarting ITSELF onto new code. A rollout that finds a live
// session updates the checkout and defers the restart; a bridge whose
// session is always live (the Coordinator's box) therefore never updates.
// The watcher reads HEAD's reflog, waits for the deploy to settle, proves
// the tree boots, and then exits for the supervisor at the first quiet
// moment — or after the deferral cap regardless.

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const T0 = Date.parse('2026-10-02T16:00:00Z');

function harness({ head, busy = 0, preflightOk = true, now = T0, bootSha = OLD, ...opts } = {}) {
  const state = { head, busy, now, log: [], warn: [], restarts: [], preflights: 0 };
  const watcher = createCodeUpdateWatcher({
    readHead: () => state.head,
    busySessions: () => state.busy,
    preflight: async () => { state.preflights++; return preflightOk ? { ok: true } : { ok: false, error: 'sharp missing' }; },
    restart: (info) => state.restarts.push(info),
    now: () => state.now,
    log: (m) => state.log.push(m),
    warn: (m) => state.warn.push(m),
    bootSha,
    ...opts,
  });
  return { state, watcher };
}

describe('parseMs / restartEnabled', () => {
  it('takes a positive integer and falls back on anything else', () => {
    expect(parseMs('90000', 5)).toBe(90000);
    expect(parseMs('0', 5)).toBe(5);
    expect(parseMs('-3', 5)).toBe(5);
    expect(parseMs('soon', 5)).toBe(5);
    expect(parseMs(undefined, 5)).toBe(5);
  });
  it('is on unless explicitly switched off', () => {
    expect(restartEnabled(undefined)).toBe(true);
    expect(restartEnabled('1')).toBe(true);
    expect(restartEnabled('yes')).toBe(true);
    for (const off of ['0', 'false', 'OFF', ' no ']) expect(restartEnabled(off)).toBe(false);
  });
  it('exits non-zero so launchd KeepAlive (SuccessfulExit=false) relaunches', () => {
    expect(RESTART_EXIT_CODE).not.toBe(0);
  });
});

describe('resolveGitDir / readHeadReflog', () => {
  it('reads the newest HEAD reflog entry from a plain checkout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
    fs.mkdirSync(path.join(dir, '.git', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'logs', 'HEAD'),
      `${'0'.repeat(40)} ${OLD} Alice Example <alice@example.com> 1759420000 +0000\tclone: from github\n`
      + `${OLD} ${NEW} Alice Example <alice@example.com> 1759421874 +0000\tmerge 7f8a820: Fast-forward\n`);
    const gitDir = resolveGitDir(dir);
    expect(gitDir).toBe(path.join(dir, '.git'));
    expect(readHeadReflog(gitDir)).toEqual({ sha: NEW, at: 1759421874000 });
  });

  it('follows a worktree .git file to its gitdir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
    const wt = path.join(dir, 'wt');
    const gitdir = path.join(dir, 'main', '.git', 'worktrees', 'wt');
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(path.join(gitdir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.relative(wt, gitdir)}\n`);
    fs.writeFileSync(path.join(gitdir, 'logs', 'HEAD'), `${OLD} ${NEW} x <x@x> 1759421874 +0100\tcheckout: moving\n`);
    expect(resolveGitDir(wt)).toBe(gitdir);
    expect(readHeadReflog(resolveGitDir(wt))).toEqual({ sha: NEW, at: 1759421874000 });
  });

  it('is null — the watcher does nothing — without a checkout, a reflog, or a parseable line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
    expect(resolveGitDir(dir)).toBeNull();
    fs.mkdirSync(path.join(dir, '.git'));
    expect(readHeadReflog(path.join(dir, '.git'))).toBeNull();
    fs.mkdirSync(path.join(dir, '.git', 'logs'));
    fs.writeFileSync(path.join(dir, '.git', 'logs', 'HEAD'), 'garbage\n');
    expect(readHeadReflog(path.join(dir, '.git'))).toBeNull();
    fs.writeFileSync(path.join(dir, '.git', 'logs', 'HEAD'), '');
    expect(readHeadReflog(path.join(dir, '.git'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'other'), 'not a gitdir pointer');
    fs.rmSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'something else\n');
    expect(resolveGitDir(dir)).toBeNull();
  });
});

describe('defaultPreflight', () => {
  it('runs node --check then the import test, in the checkout, and reports the first failure', async () => {
    const calls = [];
    const exec = (bin, args, opts, cb) => { calls.push({ bin, args, cwd: opts.cwd, env: opts.env }); cb(null, '', ''); };
    const readFileSync = () => "if (process.env.MATRON_BRIDGE_PREFLIGHT === 'module') process.exit(0);";
    expect(await defaultPreflight('/srv/bridge', { exec, readFileSync })).toEqual({ ok: true });
    expect(calls.map(c => c.args)).toEqual([['--check', 'index.js'], ['index.js']]);
    expect(calls.every(c => c.cwd === '/srv/bridge' && c.bin === process.execPath)).toBe(true);
    expect(calls[1].env.MATRON_BRIDGE_PREFLIGHT).toBe('module');

    const failing = (bin, args, opts, cb) => cb(new Error('exit 1'), '', 'SyntaxError: Unexpected token\n    at line 3\n');
    const res = await defaultPreflight('/srv/bridge', { exec: failing, readFileSync });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/--check index\.js: .*Unexpected token/);

    const throwing = () => { throw new Error('spawn ENOENT'); };
    expect((await defaultPreflight('/srv/bridge', { exec: throwing, readFileSync })).ok).toBe(false);
  });

  it('never runs index.js for a checkout without the module-mode marker (older revision)', async () => {
    const calls = [];
    const exec = (bin, args, opts, cb) => { calls.push({ args, env: opts.env }); cb(null, '', ''); };
    const old = () => "import fs from 'node:fs'; startBridge();";
    expect(await defaultPreflight('/srv/bridge', { exec, readFileSync: old })).toEqual({ ok: true });
    expect(calls.map(c => c.args)).toEqual([
      ['--check', 'index.js'],
      ['--input-type=module', '-e', "await import('sharp'); await import('./lib/inline-image.js')"],
    ]);
    // An unreadable index.js falls back the same way.
    calls.length = 0;
    const unreadable = () => { throw new Error('ENOENT'); };
    await defaultPreflight('/srv/bridge', { exec, readFileSync: unreadable });
    expect(calls[1].args[0]).toBe('--input-type=module');
  });
});

describe('createCodeUpdateWatcher — when nothing has changed', () => {
  it('does nothing while HEAD is the sha it booted on', async () => {
    const { state, watcher } = harness({ head: { sha: OLD, at: T0 - 3600_000 } });
    expect(await watcher.tick()).toEqual({ action: 'none', reason: 'unchanged' });
    expect(state.preflights).toBe(0);
    expect(state.restarts).toEqual([]);
  });

  it('does nothing, ever, without a reflog to read', async () => {
    const { state, watcher } = harness({ head: null, bootSha: null });
    expect(watcher.bootSha).toBeNull();
    expect(await watcher.tick()).toEqual({ action: 'none', reason: 'no reflog' });
    state.head = { sha: NEW, at: T0 - 3600_000 };
    // No boot sha means no basis for "newer": still nothing.
    expect(await watcher.tick()).toEqual({ action: 'none', reason: 'unchanged' });
    expect(state.restarts).toEqual([]);
  });

  it('takes the boot sha from the reflog at construction when none is given', () => {
    const { watcher } = harness({ head: { sha: OLD, at: T0 }, bootSha: null });
    expect(watcher.bootSha).toBe(OLD);
  });
});

describe('createCodeUpdateWatcher — a landed update', () => {
  it('waits for the deploy to settle before trusting the tree', async () => {
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - 1000 } });
    expect((await watcher.tick()).action).toBe('settling');
    expect(state.preflights).toBe(0);
    state.now = T0 + DEFAULT_SETTLE_MS;
    expect((await watcher.tick()).action).toBe('restart');
  });

  it('restarts at once when no session is mid-turn, after one passing preflight', async () => {
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - DEFAULT_SETTLE_MS } });
    const res = await watcher.tick();
    expect(res).toEqual({ action: 'restart', sha: NEW, forced: false, busy: 0, waitedMs: 0 });
    expect(state.preflights).toBe(1);
    expect(state.restarts).toEqual([{ sha: NEW, forced: false, busy: 0, waitedMs: 0 }]);
    expect(state.log.join('\n')).toMatch(/new code on disk: bbbbbbb \(running aaaaaaa\)/);
    expect(state.log.join('\n')).toMatch(/no session has work in flight — restarting onto bbbbbbb/);
    // Once asked to restart, the watcher is done; a late tick must not ask twice.
    expect(await watcher.tick()).toEqual({ action: 'restarted' });
    expect(state.restarts).toHaveLength(1);
  });

  it('waits while a session is mid-turn and goes at the first quiet poll', async () => {
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - DEFAULT_SETTLE_MS }, busy: 2 });
    expect(await watcher.tick()).toEqual({ action: 'waiting', sha: NEW, busy: 2, waitedMs: 0 });
    state.now = T0 + 60_000;
    expect((await watcher.tick()).action).toBe('waiting');
    // The preflight ran once for this sha, not once per poll.
    expect(state.preflights).toBe(1);
    state.busy = 0;
    state.now = T0 + 120_000;
    expect(await watcher.tick()).toEqual({ action: 'restart', sha: NEW, forced: false, busy: 0, waitedMs: 120_000 });
  });

  it('NEVER restarts while a turn is running, however long, and says so every 30 min', async () => {
    // ship-1, 2026-10-03 05:51 UTC: the old 30 min cap cut a production
    // deploy shell off mid-run. A running turn is a running turn.
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - DEFAULT_SETTLE_MS }, busy: 1 });
    await watcher.tick();
    expect(state.log.join('\n')).toMatch(/Restarting when no session has work in flight, subject to the work-hold age cap\./);
    for (let m = 1; m <= 6 * 60; m++) {
      state.now = T0 + m * 60_000;
      expect((await watcher.tick()).action).toBe('waiting');
    }
    expect(state.restarts).toEqual([]);
    // Six hours of waiting: a warning at 30, 60, … 360 min, none before.
    expect(state.warn).toHaveLength(12);
    expect(state.warn[0]).toMatch(/still waiting to restart onto bbbbbbb: 1 session\(s\) with work in flight \(a turn, background job or subagent\) for 30 min; work holds are age-capped/);
    expect(state.warn[11]).toMatch(/work in flight \(a turn, background job or subagent\) for 360 min/);
    // The moment the turn ends, it goes.
    state.busy = 0;
    state.now = T0 + 361 * 60_000;
    expect(await watcher.tick()).toEqual({ action: 'restart', sha: NEW, forced: false, busy: 0, waitedMs: 361 * 60_000 });
  });

  it('forces a mid-turn restart only when a box opts in with forceAfterMs', async () => {
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - 10_000 }, busy: 1, settleMs: 10_000, forceAfterMs: 20_000 });
    expect((await watcher.tick()).action).toBe('waiting');
    expect(state.log.join('\n')).toMatch(/forced after 0 min/);
    state.now = T0 + 19_999;
    expect((await watcher.tick()).action).toBe('waiting');
    state.now = T0 + 20_000;
    expect(await watcher.tick()).toEqual({ action: 'restart', sha: NEW, forced: true, busy: 1, waitedMs: 20_000 });
    expect(state.warn.join('\n')).toMatch(/MATRON_CODE_UPDATE_FORCE_AFTER_MS\) — restarting onto bbbbbbb anyway/);
  });

  it('honours a custom warning interval', async () => {
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - DEFAULT_SETTLE_MS }, busy: 2, warnEveryMs: 10_000 });
    await watcher.tick();
    state.now = T0 + 9_000; await watcher.tick();
    expect(state.warn).toHaveLength(0);
    state.now = T0 + 10_000; await watcher.tick();
    state.now = T0 + 15_000; await watcher.tick();
    state.now = T0 + 20_000; await watcher.tick();
    expect(state.warn).toHaveLength(2);
    expect(state.restarts).toEqual([]);
  });

  it('counts the deferral from when the update landed and settled, not from boot', async () => {
    // Boot, then an hour later a pull: the waiting clock starts at the pull.
    const { state, watcher } = harness({ head: { sha: OLD, at: T0 - 3600_000 }, busy: 1 });
    await watcher.tick();
    state.now = T0 + 3600_000;
    state.head = { sha: NEW, at: state.now - DEFAULT_SETTLE_MS };
    expect(await watcher.tick()).toEqual({ action: 'waiting', sha: NEW, busy: 1, waitedMs: 0 });
    expect(watcher.pending).toEqual({ sha: NEW, since: state.now, warnedAt: state.now });
  });
});

describe('createCodeUpdateWatcher — code that will not boot', () => {
  it('never restarts onto a tree that fails its preflight, and warns once', async () => {
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - DEFAULT_SETTLE_MS }, preflightOk: false });
    const res = await watcher.tick();
    expect(res.action).toBe('refused');
    expect(res.error).toBe('sharp missing');
    expect(state.restarts).toEqual([]);
    expect(state.warn).toHaveLength(1);
    expect(state.warn[0]).toMatch(/failed its preflight — NOT restarting onto it: sharp missing/);
    for (let i = 0; i < 5; i++) { state.now += 60_000; await watcher.tick(); }
    expect(state.preflights).toBe(1);
    expect(state.warn).toHaveLength(1);
  });

  it('forgets the refusal when the deploy rolls HEAD back, and tries a later fix', async () => {
    let ok = false;
    const state = { head: { sha: NEW, at: T0 - DEFAULT_SETTLE_MS }, now: T0, restarts: [], preflights: 0 };
    const watcher = createCodeUpdateWatcher({
      readHead: () => state.head,
      busySessions: () => 0,
      preflight: async () => { state.preflights++; return ok ? { ok: true } : { ok: false, error: 'nope' }; },
      restart: (i) => state.restarts.push(i),
      now: () => state.now,
      bootSha: OLD,
    });
    expect((await watcher.tick()).action).toBe('refused');
    // Rolled back: HEAD is the boot sha again.
    state.head = { sha: OLD, at: state.now };
    expect((await watcher.tick()).action).toBe('none');
    // A fixed tree lands.
    ok = true;
    const FIXED = 'c'.repeat(40);
    state.now += DEFAULT_SETTLE_MS;
    state.head = { sha: FIXED, at: state.now - DEFAULT_SETTLE_MS };
    expect((await watcher.tick()).action).toBe('restart');
    expect(state.preflights).toBe(2);
  });

  it('treats a throwing preflight as a failure', async () => {
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - DEFAULT_SETTLE_MS } });
    const w = createCodeUpdateWatcher({
      readHead: () => state.head, busySessions: () => 0,
      preflight: async () => { throw new Error('boom'); },
      restart: (i) => state.restarts.push(i), now: () => state.now, bootSha: OLD,
      warn: (m) => state.warn.push(m),
    });
    void watcher;
    expect((await w.tick()).action).toBe('refused');
    expect(state.warn[0]).toMatch(/boom/);
    expect(state.restarts).toEqual([]);
  });
});

describe('createCodeUpdateWatcher — HEAD moving again', () => {
  it('drops a pending restart when HEAD returns to the running sha', async () => {
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - DEFAULT_SETTLE_MS }, busy: 1 });
    await watcher.tick();
    expect(watcher.pending?.sha).toBe(NEW);
    state.head = { sha: OLD, at: T0 + 1000 };
    state.now = T0 + 2000;
    expect(await watcher.tick()).toEqual({ action: 'none', reason: 'unchanged' });
    expect(watcher.pending).toBeNull();
    expect(state.log.join('\n')).toMatch(/HEAD is back on aaaaaaa; the pending restart is off/);
  });

  it('re-preflights and restarts the clock when a second update lands on top', async () => {
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - DEFAULT_SETTLE_MS }, busy: 1 });
    await watcher.tick();
    const NEWER = 'd'.repeat(40);
    state.now = T0 + 10 * 60_000;
    state.head = { sha: NEWER, at: state.now - DEFAULT_SETTLE_MS };
    expect(await watcher.tick()).toEqual({ action: 'waiting', sha: NEWER, busy: 1, waitedMs: 0 });
    expect(state.preflights).toBe(2);
    expect(watcher.pending).toEqual({ sha: NEWER, since: state.now, warnedAt: state.now });
  });

  it('ignores ticks that land while a preflight is running', async () => {
    let release;
    const state = { restarts: [] };
    const watcher = createCodeUpdateWatcher({
      readHead: () => ({ sha: NEW, at: T0 - DEFAULT_SETTLE_MS }),
      busySessions: () => 0,
      preflight: () => new Promise(r => { release = r; }),
      restart: (i) => state.restarts.push(i),
      now: () => T0, bootSha: OLD,
    });
    const first = watcher.tick();
    expect(await watcher.tick()).toEqual({ action: 'checking', sha: NEW });
    release({ ok: true });
    expect((await first).action).toBe('restart');
    expect(state.restarts).toHaveLength(1);
  });
});

describe('createCodeUpdateWatcher — defaults', () => {
  it('settles 5 min, warns every 30 min, and never forces unless told to', () => {
    expect(DEFAULT_SETTLE_MS).toBe(5 * 60_000);
    expect(DEFAULT_WARN_EVERY_MS).toBe(30 * 60_000);
    expect(DEFAULT_FORCE_AFTER_MS).toBe(0);
    expect(parseMsOrOff(undefined, 0)).toBe(0);
    expect(parseMsOrOff('0', 5)).toBe(0);
    expect(parseMsOrOff('600000', 0)).toBe(600000);
    expect(parseMsOrOff('-1', 0)).toBe(0);
    expect(parseMsOrOff('later', 7)).toBe(7);
    vi.restoreAllMocks();
  });
});

describe('self-restart stamp — carrying on by itself', () => {
  it('is on unless switched off, and the text is marked as the bridge talking', () => {
    expect(autoCarryOnEnabled(undefined)).toBe(true);
    expect(autoCarryOnEnabled('0')).toBe(false);
    expect(AUTO_CARRY_ON_TEXT).toMatch(/^\[auto-continue after bridge update\] /);
  });

  it('round-trips through the file and is gone after one take', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cur-')), 'stamp.json');
    writeSelfRestartStamp(file, { bootId: 'boot-1', sha: NEW, busy: 2, at: T0 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ bootId: 'boot-1', sha: NEW, busy: 2, at: T0 });
    expect(takeSelfRestartStamp(file)).toEqual({ bootId: 'boot-1', sha: NEW, busy: 2, at: T0 });
    expect(() => fs.readFileSync(file)).toThrow();
    expect(takeSelfRestartStamp(file)).toBeNull();
  });

  it('stamps the time itself when none is given', () => {
    const writes = [];
    writeSelfRestartStamp('/x', { bootId: 'b', sha: NEW }, { write: (_f, d) => writes.push(JSON.parse(d)) });
    expect(writes[0].bootId).toBe('b');
    expect(Number.isFinite(writes[0].at)).toBe(true);
  });

  it('is null — the chats get a card — for a malformed or bootId-less stamp, and removes it anyway', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
    const file = path.join(dir, 'stamp.json');
    fs.writeFileSync(file, 'not json');
    expect(takeSelfRestartStamp(file)).toBeNull();
    expect(() => fs.readFileSync(file)).toThrow();
    fs.writeFileSync(file, JSON.stringify({ sha: NEW }));
    expect(takeSelfRestartStamp(file)).toBeNull();
    expect(() => fs.readFileSync(file)).toThrow();
    // A stamp that cannot be removed must not be used either: the next boot
    // would find it again and resume the same turns twice.
    fs.writeFileSync(file, JSON.stringify({ bootId: 'b' }));
    expect(takeSelfRestartStamp(file, { unlinkSync: () => { throw new Error('EACCES'); } })).toBeNull();
  });

  it('selects only the markers the stamped run wrote; everything else keeps the tap', () => {
    const mine = { convoId: 'c1', bootId: 'boot-1' };
    const older = { convoId: 'c2', bootId: 'boot-0' };
    const unknown = { convoId: 'c3' };
    const stamp = { bootId: 'boot-1', sha: NEW };
    expect(selectAutoCarryOn([mine, older, unknown], stamp)).toEqual({ auto: [mine], card: [older, unknown] });
    expect(selectAutoCarryOn([mine, older], null)).toEqual({ auto: [], card: [mine, older] });
    expect(selectAutoCarryOn([mine], stamp, { enabled: false })).toEqual({ auto: [], card: [mine] });
    expect(selectAutoCarryOn(null, stamp)).toEqual({ auto: [], card: [] });
  });
});

describe('restart gate', () => {
  const landed = { sha: NEW, at: T0 - DEFAULT_SETTLE_MS };
  const GATE_CAP = 60_000;
  const gateOf = (state, verdict) => async () => { state.gateCalls = (state.gateCalls || 0) + 1; return typeof verdict === 'function' ? verdict() : verdict; };

  it('unset: restarts at the first quiet poll as before', async () => {
    const { watcher } = harness({ head: landed });
    expect((await watcher.tick()).action).toBe('restart');
  });

  it('a hold delays the restart and a later safe verdict lets it through', async () => {
    const state = {};
    let verdict = { hold: true, reason: 'nightly backup running' };
    const h = harness({ head: landed, gate: gateOf(state, () => verdict), gateMaxMs: GATE_CAP });
    expect(await h.watcher.tick()).toMatchObject({ action: 'waiting', gate: 'nightly backup running' });
    expect(h.state.restarts).toEqual([]);
    h.state.now = T0 + 10_000;
    verdict = { hold: false };
    expect((await h.watcher.tick()).action).toBe('restart');
  });

  it('puts the gate reason in the 30-minute warning', async () => {
    const state = {};
    const h = harness({ head: landed, gate: gateOf(state, { hold: true, reason: 'nightly backup running' }), gateMaxMs: 3600_000 });
    await h.watcher.tick();
    expect(h.state.warn).toHaveLength(0);
    h.state.now = T0 + DEFAULT_WARN_EVERY_MS;
    await h.watcher.tick();
    expect(h.state.warn.join('\n')).toMatch(/held by the restart gate for 30 min \(nightly backup running\)/);
  });

  it('expires at the cap, restarts and logs it', async () => {
    const state = {};
    const h = harness({ head: landed, gate: gateOf(state, { hold: true, reason: 'backup' }), gateMaxMs: GATE_CAP });
    await h.watcher.tick();
    h.state.now = T0 + GATE_CAP - 1;
    expect((await h.watcher.tick()).action).toBe('waiting');
    h.state.now = T0 + GATE_CAP;
    expect((await h.watcher.tick()).action).toBe('restart');
    expect(h.state.warn.join('\n')).toMatch(/past the 1 min cap, restarting anyway/);
  });

  it('counts a gate that throws or reports an error as safe, logged', async () => {
    const state = {};
    const h = harness({ head: landed, gate: gateOf(state, () => { throw new Error('boom'); }) });
    expect((await h.watcher.tick()).action).toBe('restart');
    expect(h.state.warn.join('\n')).toMatch(/restart gate failed \(boom\)/);
    const h2 = harness({ head: landed, gate: gateOf(state, { hold: false, error: 'timed out after 5000ms' }) });
    expect((await h2.watcher.tick()).action).toBe('restart');
    expect(h2.state.warn.join('\n')).toMatch(/timed out after 5000ms/);
  });

  it('gateMaxMs 0: a hold never lapses, even past the default eight hours', async () => {
    const state = {};
    const h = harness({ head: landed, gate: gateOf(state, { hold: true, reason: 'backup' }), gateMaxMs: 0 });
    expect((await h.watcher.tick()).action).toBe('waiting');
    h.state.now = T0 + 9 * 3600_000;
    expect(await h.watcher.tick()).toMatchObject({ action: 'waiting', gate: 'backup' });
    expect(h.state.restarts).toEqual([]);
    h.state.now = T0 + 9 * 3600_000 + DEFAULT_WARN_EVERY_MS;
    await h.watcher.tick();
    expect(h.state.warn.join('\n')).toMatch(/the hold never expires/);
    expect(h.state.warn.join('\n')).not.toMatch(/restarting anyway/);
  });

  it('default cap still lapses at eight hours', async () => {
    const state = {};
    const h = harness({ head: landed, gate: gateOf(state, { hold: true, reason: 'backup' }) });
    expect((await h.watcher.tick()).action).toBe('waiting');
    h.state.now = T0 + 8 * 3600_000 - 1;
    expect((await h.watcher.tick()).action).toBe('waiting');
    h.state.now = T0 + 8 * 3600_000;
    expect((await h.watcher.tick()).action).toBe('restart');
  });

  it('gateOnError hold: a throw, an exit code, a timeout or a spawn failure hold with the error as reason', async () => {
    for (const verdict of [
      () => { throw new Error('boom'); },
      { hold: false, error: 'exit 2' },
      { hold: false, error: 'timed out after 5000ms' },
      { hold: false, error: 'spawn /nope ENOENT' },
    ]) {
      const h = harness({ head: landed, gate: gateOf({}, verdict), gateMaxMs: 0, gateOnError: 'hold' });
      const r = await h.watcher.tick();
      expect(r.action).toBe('waiting');
      expect(r.gate).toMatch(/^gate error: /);
      expect(h.state.restarts).toEqual([]);
      expect(h.state.warn.join('\n')).toMatch(/holding the restart/);
    }
  });

  it('gateOnError hold: a good verdict after an error goes through', async () => {
    let verdict = { hold: false, error: 'exit 2' };
    const h = harness({ head: landed, gate: gateOf({}, () => verdict), gateMaxMs: 0, gateOnError: 'hold' });
    expect((await h.watcher.tick()).action).toBe('waiting');
    verdict = { hold: false };
    expect((await h.watcher.tick()).action).toBe('restart');
  });

  it('gateOnError hold: the same error is warned about once', async () => {
    const h = harness({ head: landed, gate: gateOf({}, { hold: false, error: 'exit 2' }), gateMaxMs: 0, gateOnError: 'hold' });
    await h.watcher.tick();
    h.state.now = T0 + 1000;
    await h.watcher.tick();
    expect(h.state.warn.filter(m => /restart gate failed \(exit 2\)/.test(m))).toHaveLength(1);
  });

  it('a request made with force skips the gate; sessions with work still hold it', async () => {
    const state = {};
    const h = harness({ head: landed, gate: gateOf(state, { hold: true, reason: 'backup' }), gateMaxMs: 0, gateOnError: 'hold' });
    expect((await h.watcher.tick()).action).toBe('waiting');
    h.watcher.request({ reason: 'x', force: true });
    expect(h.watcher.requested.force).toBe(true);
    const calls = state.gateCalls;
    expect((await h.watcher.tick()).action).toBe('restart');
    expect(state.gateCalls).toBe(calls);
    const busy = harness({ head: landed, busy: 1, gate: gateOf({}, { hold: true, reason: 'backup' }), gateMaxMs: 0 });
    busy.watcher.request({ reason: 'x', force: true });
    expect((await busy.watcher.tick()).action).toBe('waiting');
  });

  it('logs a forced request, and says nothing about force otherwise', () => {
    const f = harness({ head: landed });
    f.watcher.request({ reason: 'x', force: true });
    expect(f.state.log.join('\n')).toMatch(/force: the restart gate is skipped/);
    const n = harness({ head: landed });
    n.watcher.request({ reason: 'x' });
    expect(n.state.log.join('\n')).not.toMatch(/force/);
  });

  it('a request without force is still held by the gate', async () => {
    const h = harness({ head: landed, gate: gateOf({}, { hold: true, reason: 'backup' }), gateMaxMs: 0 });
    h.watcher.request({ reason: 'x' });
    expect(h.watcher.requested.force).toBeUndefined();
    expect((await h.watcher.tick()).action).toBe('waiting');
  });

  it('notifies once when an authoritative hold goes on long, and when the gate itself keeps failing', async () => {
    const notes = [];
    const h = harness({ head: landed, gate: gateOf({}, { hold: true, reason: 'backup' }), gateMaxMs: 0, notify: (m) => notes.push(m) });
    await h.watcher.tick();
    h.state.now = T0 + 30 * 60_000 - 1;
    await h.watcher.tick();
    expect(notes).toHaveLength(0);
    h.state.now = T0 + 30 * 60_000;
    await h.watcher.tick();
    h.state.now = T0 + 3 * 3600_000;
    await h.watcher.tick();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/held by the restart gate for 30 min \(backup\)/);
    expect(notes[0]).toMatch(/"force": true/);

    const errNotes = [];
    const e = harness({ head: landed, gate: gateOf({}, { hold: false, error: 'spawn /nope ENOENT' }), gateMaxMs: 0, gateOnError: 'hold', notify: (m) => errNotes.push(m) });
    await e.watcher.tick();
    e.state.now = T0 + 30 * 60_000;
    await e.watcher.tick();
    expect(errNotes).toHaveLength(1);
    expect(errNotes[0]).toMatch(/gate error: spawn \/nope ENOENT/);
  });

  it('does not notify in the default advisory mode, and a throwing notify does not break the watcher', async () => {
    const notes = [];
    const h = harness({ head: landed, gate: gateOf({}, { hold: true, reason: 'backup' }), gateMaxMs: 8 * 3600_000, notify: (m) => notes.push(m) });
    await h.watcher.tick();
    h.state.now = T0 + 3 * 3600_000;
    await h.watcher.tick();
    expect(notes).toHaveLength(0);
    const c = harness({ head: landed, gate: gateOf({}, { hold: true, reason: 'backup' }), gateMaxMs: 0, gateNoticeAfterMs: 5 * 60_000, notify: (m) => notes.push(m) });
    await c.watcher.tick();
    c.state.now = T0 + 5 * 60_000;
    await c.watcher.tick();
    expect(notes).toHaveLength(1);
    const t = harness({ head: landed, gate: gateOf({}, { hold: true, reason: 'backup' }), gateMaxMs: 0, notify: () => { throw new Error('x'); } });
    await t.watcher.tick();
    t.state.now = T0 + 3 * 3600_000;
    expect((await t.watcher.tick()).action).toBe('waiting');
  });

  it('gateOnError hold with a real command: a missing gate program holds', async () => {
    const gate = createCommandGate('/nonexistent/gate-binary');
    const h = harness({ head: landed, gate, gateMaxMs: 0, gateOnError: 'hold' });
    expect(await h.watcher.tick()).toMatchObject({ action: 'waiting' });
    expect(h.state.restarts).toEqual([]);
  });

  it('re-checks work after the gate answers: a turn that started meanwhile holds the restart', async () => {
    const state = {};
    let release;
    const slow = () => new Promise(r => { release = () => r({ hold: false }); });
    const h = harness({ head: landed, gate: gateOf(state, slow) });
    const p = h.watcher.tick();
    await Promise.resolve();
    h.state.busy = 1;
    release();
    expect((await p).action).toBe('waiting');
    expect(h.state.restarts).toEqual([]);
  });

  it('re-validates HEAD after the gate answers: a newer revision goes back through settle and preflight', async () => {
    const state = {};
    let release;
    const slow = () => new Promise(r => { release = () => r({ hold: false }); });
    const h = harness({ head: landed, gate: gateOf(state, slow) });
    const p = h.watcher.tick();
    await Promise.resolve();
    h.state.head = { sha: 'c'.repeat(40), at: T0 };
    release();
    expect((await p).action).toBe('settling');
    expect(h.state.restarts).toEqual([]);
  });

  it('never asks the gate for a forced restart', async () => {
    const state = {};
    const h = harness({ head: { sha: NEW, at: T0 - 10_000 }, busy: 1, settleMs: 10_000, forceAfterMs: 20_000, gate: gateOf(state, { hold: true, reason: 'x' }) });
    await h.watcher.tick();
    h.state.now = T0 + 20_000;
    expect((await h.watcher.tick()).forced).toBe(true);
    expect(state.gateCalls).toBeUndefined();
  });
});

describe('createCommandGate', () => {
  const fake = (err, stdout = '') => vi.fn((file, args, opts, cb) => cb(err, stdout, ''));

  it('settles on its own deadline and kills the child when the callback never arrives', async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn();
      const exec = vi.fn(() => ({ kill }));
      const p = createCommandGate('hook', { exec, timeoutMs: 1000 })();
      await vi.advanceTimersByTimeAsync(1300);
      expect(await p).toEqual({ hold: false, error: 'timed out after 1000ms' });
      expect(kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is off for an unset or blank command', () => {
    expect(createCommandGate(undefined)).toBeNull();
    expect(createCommandGate('   ')).toBeNull();
  });

  it('runs the argv with a timeout and treats exit 0 as safe', async () => {
    const exec = fake(null);
    expect(await createCommandGate('/usr/bin/check --quiet', { exec, timeoutMs: 1234 })()).toEqual({ hold: false });
    expect(exec).toHaveBeenCalledWith('/usr/bin/check', ['--quiet'], expect.objectContaining({ timeout: 1234 }), expect.any(Function));
  });

  it('exit 1 holds, with the first stdout line as the reason', async () => {
    const exec = fake(Object.assign(new Error('x'), { code: 1 }), 'deploy in progress\nmore\n');
    expect(await createCommandGate('check', { exec })()).toEqual({ hold: true, reason: 'deploy in progress' });
    const bare = fake(Object.assign(new Error('x'), { code: 1 }), '');
    expect((await createCommandGate('check', { exec: bare })()).reason).toBe('no reason given');
  });

  it('other exits, a timeout and a spawn failure count as safe with an error', async () => {
    const r = (err) => createCommandGate('check', { exec: fake(err), timeoutMs: 50 })();
    expect(await r(Object.assign(new Error('x'), { code: 2 }))).toEqual({ hold: false, error: 'exit 2' });
    expect(await r(Object.assign(new Error('x'), { code: null, killed: true, signal: 'SIGTERM' }))).toEqual({ hold: false, error: 'timed out after 50ms' });
    expect(await r(Object.assign(new Error('spawn check ENOENT'), { code: 'ENOENT' }))).toEqual({ hold: false, error: 'exit ENOENT' });
    const thrower = vi.fn(() => { throw new Error('bad'); });
    expect(await createCommandGate('check', { exec: thrower })()).toEqual({ hold: false, error: 'bad' });
  });
});

describe('gateEnv', () => {
  it('keeps PATH, HOME and MATRON_RESTART_GATE_* and drops everything else', () => {
    expect(gateEnv({
      PATH: '/bin', HOME: '/home/x', MATRON_RESTART_GATE_FOO: '1', MATRON_RESTART_GATE_CMD: 'check',
      MATRON_API_TOKEN: 'secret', SECRET: 's', MATRON_BRIDGE_PLUGINS: '/p.mjs',
    })).toEqual({ PATH: '/bin', HOME: '/home/x', MATRON_RESTART_GATE_FOO: '1', MATRON_RESTART_GATE_CMD: 'check' });
  });

  it('passes the minimal env and a detached spawn to the exec', async () => {
    const exec = vi.fn((file, args, opts, cb) => cb(null, '', ''));
    await createCommandGate('check', { exec, env: { PATH: '/bin', HOME: '/h', TOKEN: 'secret' } })();
    const opts = exec.mock.calls[0][2];
    expect(opts.env).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(opts.detached).toBe(process.platform !== 'win32');
  });
});

describe('createCommandGate with a real child', () => {
  it.skipIf(process.platform === 'win32')('runs the hook without the bridge secrets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const script = path.join(dir, 'hook.js');
    fs.writeFileSync(script, "process.stdout.write(Object.keys(process.env).includes('GATE_TEST_SECRET') ? 'leaked' : 'clean'); process.exit(1);");
    process.env.GATE_TEST_SECRET = 'x';
    try {
      expect(await createCommandGate(`${process.execPath} ${script}`)()).toEqual({ hold: true, reason: 'clean' });
    } finally {
      delete process.env.GATE_TEST_SECRET;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')("kills the hook's own children on timeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const script = path.join(dir, 'hook.js');
    const pidFile = path.join(dir, 'child.pid');
    fs.writeFileSync(script, `
const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setInterval(() => {}, 1000);
`);
    let grandchild;
    try {
      const gate = createCommandGate(`${process.execPath} ${script}`, { timeoutMs: 600 });
      expect(await gate()).toEqual({ hold: false, error: 'timed out after 600ms' });
      grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      let alive = true;
      for (let i = 0; i < 40 && alive; i++) {
        try { process.kill(grandchild, 0); await new Promise(r => setTimeout(r, 50)); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    } finally {
      try { if (grandchild) process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settles on its own deadline when the hook ignores SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const script = path.join(dir, 'hook.js');
    fs.writeFileSync(script, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    try {
      const gate = createCommandGate(`${process.execPath} ${script}`, { timeoutMs: 200 });
      const started = Date.now();
      expect(await gate()).toEqual({ hold: false, error: 'timed out after 200ms' });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
