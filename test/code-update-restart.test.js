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
      `${'0'.repeat(40)} ${OLD} Dan Barker <dan@example.com> 1759420000 +0000\tclone: from github\n`
      + `${OLD} ${NEW} Dan Barker <dan@example.com> 1759421874 +0000\tmerge 7f8a820: Fast-forward\n`);
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
    const exec = (bin, args, opts, cb) => { calls.push({ bin, args, cwd: opts.cwd }); cb(null, '', ''); };
    expect(await defaultPreflight('/srv/bridge', { exec })).toEqual({ ok: true });
    expect(calls.map(c => c.args[0])).toEqual(['--check', '--input-type=module']);
    expect(calls.every(c => c.cwd === '/srv/bridge' && c.bin === process.execPath)).toBe(true);
    expect(calls[1].args[2]).toMatch(/import\('sharp'\)/);

    const failing = (bin, args, opts, cb) => cb(new Error('exit 1'), '', 'SyntaxError: Unexpected token\n    at line 3\n');
    const res = await defaultPreflight('/srv/bridge', { exec: failing });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/--check index\.js: .*Unexpected token/);

    const throwing = () => { throw new Error('spawn ENOENT'); };
    expect((await defaultPreflight('/srv/bridge', { exec: throwing })).ok).toBe(false);
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
    expect(state.log.join('\n')).toMatch(/no session mid-turn — restarting onto bbbbbbb/);
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
    // deploy-1, 2026-10-03 05:51 UTC: the old 30 min cap cut a production
    // deploy shell off mid-run. A running turn is a running turn.
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - DEFAULT_SETTLE_MS }, busy: 1 });
    await watcher.tick();
    expect(state.log.join('\n')).toMatch(/Restarting when no session is mid-turn, never mid-turn\./);
    for (let m = 1; m <= 6 * 60; m++) {
      state.now = T0 + m * 60_000;
      expect((await watcher.tick()).action).toBe('waiting');
    }
    expect(state.restarts).toEqual([]);
    // Six hours of waiting: a warning at 30, 60, … 360 min, none before.
    expect(state.warn).toHaveLength(12);
    expect(state.warn[0]).toMatch(/still waiting to restart onto bbbbbbb: 1 session\(s\) mid-turn for 30 min; a running turn is never cut off/);
    expect(state.warn[11]).toMatch(/mid-turn for 360 min/);
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
