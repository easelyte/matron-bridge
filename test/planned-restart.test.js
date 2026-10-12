import { describe, expect, it, vi } from 'vitest';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { preflightSupport } from '../lib/preflight-support.js';
import { createPlannedRestartState } from '../lib/planned-restart-state.js';
import { createPlannedRestart } from '../lib/planned-restart.js';
import { evaluateQuiet } from '../lib/restart-quiet.js';

const minute = 60_000;
const empty = () => ({ state: null, requests: [], boot_sha: 'old', notified: {} });
const pending = () => ({ ...empty(), id: 'restart-a', state: 'pending', requests: [{ sha: 'old' }], first_request_at: 0, last_request_at: 0 });
function setup(options = {}) {
  let time = 0;
  let head = 'new';
  let dirty = '';
  let env = 'VALID=yes';
  let stamp = 1;
  let state = options.state || empty();
  let quiet = { quiet: true, holders: [], probe_error: null };
  const store = { getState: vi.fn(() => structuredClone(state)), addRequest: vi.fn(), setState: vi.fn() };
  const git = vi.fn(args => {
    if (args[0] === 'rev-parse') return head;
    if (args[0] === 'status') return args.includes('--untracked-files=no') ? dirty : '?? scratch';
    if (args[0] === 'merge-base') {
      const [, , from, to] = args;
      return from === to || (from === 'old' && to === 'new') || (['old', 'new'].includes(from) && to === 'landed');
    }
    throw new Error('unexpected git command');
  });
  const fs = { readFileSync: vi.fn(file => file.endsWith('.env') ? env : 'lock'),
    statSync: vi.fn(() => ({ ino: stamp, mtimeMs: stamp })) };
  const preflight = vi.fn(async () => ({ ok: true }));
  const support = vi.fn(() => 'gate/1');
  const warn = vi.fn();
  const onReady = vi.fn();
  const gate = createPlannedRestart({ repoDir: 'checkout', git, fs, stateStore: store,
    now: () => time, quietEvaluator: () => quiet, sessions: () => [],
    preflight, support, warn, onReady, collectMs: minute, ...options });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const good = async (arg = {}) => { gate.evaluate(arg); await flush(); return gate.evaluate(arg); };
  return { gate, git, fs, store, preflight, support, warn, onReady, flush, good,
    time: value => { time = value; }, head: value => { head = value; }, dirty: value => { dirty = value; },
    env: value => { env = value; }, stamp: value => { stamp = value; },
    state: value => { state = value; }, quiet: value => { quiet = value; } };
}

describe('planned restart gate', () => {
  it('warns at each half-hour boundary without duplicate warnings', async () => {
    const h = setup({ state: pending() });
    h.dirty(' M index.js');
    h.gate.tick();
    h.time(30 * minute - 1);
    h.gate.tick();
    expect(h.warn).not.toHaveBeenCalled();
    h.time(30 * minute);
    const verdict = h.gate.tick();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenLastCalledWith('Planned restart still pending; waiting for restart gates to pass; never forcing');
    expect(verdict).toEqual({ would_pass: false, waiting_on: {
      quiet: { holders: [], probe_error: null }, code: 'dirty tree',
      preflight: { unknown: true }, collect: null, unwarned: [],
    } });
    for (const time of [30 * minute, 30 * minute + 1, 60 * minute - 1]) {
      h.time(time);
      h.gate.tick();
      expect(h.warn).toHaveBeenCalledTimes(1);
    }
    h.time(60 * minute);
    h.gate.tick();
    expect(h.warn).toHaveBeenCalledTimes(2);
    h.time(60 * minute + 1);
    h.gate.tick();
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.onReady).not.toHaveBeenCalled();
    h.state({ ...pending(), id: 'restart-b', first_request_at: 70 * minute, last_request_at: 70 * minute });
    h.time(100 * minute - 1);
    h.gate.tick();
    expect(h.warn).toHaveBeenCalledTimes(2);
    h.time(100 * minute);
    h.gate.tick();
    expect(h.warn).toHaveBeenCalledTimes(3);
  });
  it('warns only from pending blocked ticks and resets cadence for a new restart', async () => {
    const h = setup({ state: pending() });
    h.dirty(' M index.js');
    h.time(30 * minute);
    h.gate.evaluate({ dryRun: true });
    h.gate.evaluate();
    expect(h.warn).not.toHaveBeenCalled();
    h.gate.tick();
    expect(h.warn).toHaveBeenCalledTimes(1);
    for (const state of [null, 'restarting', 'back', 'abandoned', 'cancelled']) {
      h.state({ ...pending(), state });
      h.time(60 * minute);
      h.gate.tick();
      expect(h.warn).toHaveBeenCalledTimes(1);
    }
    h.state({ ...pending(), id: 'restart-b', first_request_at: 60 * minute, last_request_at: 60 * minute });
    h.time(90 * minute - 1);
    h.gate.tick();
    expect(h.warn).toHaveBeenCalledTimes(1);
    h.time(90 * minute);
    h.gate.tick();
    expect(h.warn).toHaveBeenCalledTimes(2);
    h.dirty('');
    h.time(120 * minute);
    await h.good();
    h.gate.tick();
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.onReady).toHaveBeenCalledOnce();
  });
  it.each(['quiet confirmation', 'undelivered notice', 'changed preflight inputs'])(
    'warns while the real gate waits for %s even after a passing dry run', async blocker => {
      const h = setup({ state: pending(), collectMs: 0,
        sessions: () => blocker === 'undelivered notice' ? [{ alive: true, journalConvoId: 'alice' }] : [] });
      if (blocker === 'quiet confirmation') h.quiet({ quiet: false, holders: [], probe_error: null });
      h.time(30 * minute);
      expect((await h.good({ dryRun: true })).would_pass).toBe(true);
      if (blocker === 'changed preflight inputs') {
        h.fs.statSync.mockReturnValue({ ino: 2, mtimeMs: 1 });
      }
      h.gate.tick();
      expect(h.warn).toHaveBeenCalledTimes(1);
      expect(h.onReady).not.toHaveBeenCalled();
    });
  it.each(['busy session', 'probe exception', 'git timeout', 'missing input', 'preflight timeout', 'running preflight'])(
    'warns throughout two days with %s without forcing or shutting down', async blocker => {
      const shutdown = vi.fn();
      const h = setup({ state: pending(), collectMs: 0, onReady: shutdown,
        ...(blocker === 'probe exception' ? { quietEvaluator: () => { throw new Error('unavailable'); } } : {}),
        ...(blocker === 'preflight timeout' ? { preflight: async () => { throw new Error('timeout'); } } : {}),
        ...(blocker === 'running preflight' ? { preflight: () => new Promise(() => {}) } : {}),
      });
      if (blocker === 'busy session') h.quiet({ quiet: false, holders: [{ convoId: 'alice', why: 'busy' }], probe_error: null });
      if (blocker === 'git timeout') h.git.mockImplementation(() => { throw new Error('timeout'); });
      if (blocker === 'missing input') h.fs.readFileSync.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
      const before = h.store.getState();
      for (let time = 0; time <= 48 * 60 * minute; time += 30 * minute) {
        h.time(time);
        const verdict = h.gate.tick();
        await h.flush();
        const warnings = h.warn.mock.calls.filter(([message]) => message.startsWith('Planned restart still pending'));
        expect(warnings).toHaveLength(time / (30 * minute));
        expect(verdict.would_pass).toBe(false);
        expect(shutdown).not.toHaveBeenCalled();
        expect(h.store.getState()).toEqual(before);
        expect(h.store.setState).not.toHaveBeenCalled();
        expect(h.store.addRequest).not.toHaveBeenCalled();
      }
    });
  it('retries the same pending restart until the callback commits the latch', async () => {
    const h = setup({ state: pending(), collectMs: 0 });
    h.onReady.mockReturnValueOnce(undefined).mockReturnValueOnce({ latched: false })
      .mockImplementationOnce(() => { throw new Error('latch failed'); })
      .mockReturnValue({ latched: true });
    await h.good({ dryRun: true });
    h.gate.tick();
    expect(h.onReady).toHaveBeenCalledTimes(1);
    h.quiet({ quiet: false, holders: [{ convoId: 'alice', why: 'busy' }], probe_error: null });
    h.gate.tick();
    expect(h.onReady).toHaveBeenCalledTimes(1);
    h.quiet({ quiet: true, holders: [], probe_error: null });
    expect(h.gate.tick().would_pass).toBe(true);
    expect(h.onReady).toHaveBeenCalledTimes(2);
    expect(() => h.gate.tick()).toThrow('latch failed');
    expect(h.onReady).toHaveBeenCalledTimes(3);
    h.gate.tick();
    expect(h.onReady).toHaveBeenCalledTimes(4);
    expect(h.onReady.mock.calls.map(([ready]) => ready.state.id)).toEqual(Array(4).fill(pending().id));
  });
  it('delivers a committed latch only once for the same restart', async () => {
    const h = setup({ state: pending(), collectMs: 0 });
    h.onReady.mockReturnValue({ latched: true });
    await h.good({ dryRun: true });
    h.gate.tick();
    h.gate.tick();
    expect(h.onReady).toHaveBeenCalledOnce();
  });
  it('requires two real quiet polls, including after probe recovery, without counting dry runs', async () => {
    let probeOk = true;
    const h = setup({ state: pending(), collectMs: 0, quietEvaluator: evaluateQuiet,
      quietOptions: () => ({ sessions: [], bootAt: 0,
        readProcessTable: () => ({ ok: probeOk, table: [] }), listRunningSubagents: () => [] }) });
    h.onReady.mockReturnValue({ latched: true });
    await h.good({ dryRun: true });
    expect(h.gate.tick().would_pass).toBe(true);
    expect(h.onReady).not.toHaveBeenCalled();
    h.gate.evaluate({ dryRun: true });
    h.gate.tick();
    expect(h.onReady).toHaveBeenCalledTimes(1);
    h.state({ ...pending(), id: 'restart-b' });
    probeOk = false;
    expect(h.gate.tick().waiting_on.quiet.probe_error).toBe('process_table');
    expect(h.onReady).toHaveBeenCalledTimes(1);
    probeOk = true;
    await h.good({ dryRun: true });
    expect(h.gate.tick().would_pass).toBe(true);
    expect(h.onReady).toHaveBeenCalledTimes(1);
    h.gate.tick();
    expect(h.onReady).toHaveBeenCalledTimes(2);
    expect(h.onReady.mock.calls[1][0].state.id).toBe('restart-b');
  });
  it('requires each requested commit to be an ancestor of HEAD', async () => {
    const h = setup();
    expect(h.gate.evaluate({ dryRun: true, request: { sha: 'future' } }).waiting_on.code).toBe('not a descendant');
    expect((await h.good({ dryRun: true, request: { sha: 'old' } })).would_pass).toBe(true);
    expect(h.gate.evaluate({ request: { sha: 'future' } }).would_pass).toBe(false);
    expect(h.gate.evaluate({ request: null }).would_pass).toBe(false);
    expect(h.gate.evaluate({ request: { sha: '' } }).would_pass).toBe(false);
  });
  it('checks tracked changes and ignores untracked files', async () => {
    const h = setup();
    expect((await h.good()).would_pass).toBe(true);
    h.dirty(' M index.js');
    expect(h.gate.evaluate().waiting_on.code).toBe('dirty tree');
  });
  it('requires landed HEAD and pins config-only requests to the boot commit', async () => {
    const h = setup({ landedRef: 'landed' });
    expect(h.gate.evaluate({ request: {} }).waiting_on.code).toBe('head moved (config-only)');
    expect((await h.good({ request: { sha: 'old' } })).would_pass).toBe(true);
    h.head('future');
    expect(h.gate.evaluate({ request: { sha: 'future' } }).waiting_on.code).toBe('head not landed');
    h.head('old');
    expect((await h.good({ request: {} })).would_pass).toBe(true);
    const free = setup();
    expect((await free.good({ request: {} })).would_pass).toBe(true);
  });
  it('collects recent requests but opens at the fixed cap', async () => {
    const h = setup({ state: pending() });
    await h.good();
    h.time(minute - 1);
    expect(h.gate.evaluate().waiting_on.collect).toEqual({ remaining_ms: 1 });
    h.time(minute);
    expect(h.gate.evaluate().waiting_on.collect).toBeNull();
    h.state({ ...pending(), last_request_at: 30 * minute - 1 });
    h.time(30 * minute - 1);
    expect(h.gate.evaluate().waiting_on.collect).toEqual({ remaining_ms: 1 });
    h.time(30 * minute);
    expect(h.gate.evaluate().waiting_on.collect).toBeNull();
  });
  it('batches three requests onto the newest checkout after collection', async () => {
    const h = setup({ state: pending(), collectMs: 3 * minute });
    await h.good();
    h.state({ ...pending(), last_request_at: 4 * minute, requests: [{ sha: 'old' }, { sha: 'new' }, { sha: 'new' }] });
    h.time(7 * minute - 1);
    expect(h.gate.tick().waiting_on.collect).toEqual({ remaining_ms: 1 });
    expect(h.onReady).not.toHaveBeenCalled();
    h.time(7 * minute);
    h.gate.tick();
    await h.flush();
    h.gate.tick();
    expect(h.onReady).toHaveBeenCalledOnce();
    expect(h.onReady.mock.calls[0][0].sha).toBe('new');
  });
  it('reports unknown while preflight is running and never passes unknown', async () => {
    let finish;
    const preflight = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const h = setup({ preflight });
    expect(h.gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
    expect(h.gate.evaluate().would_pass).toBe(false);
    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledWith('checkout', { mode: 'gate' });
    finish({ ok: true });
    await h.flush();
    expect(h.gate.evaluate().would_pass).toBe(true);
    h.head('old');
    expect(h.gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
  });
  it('refuses unsupported trees before running a child and preserves capability bytes', async () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'restart-gate-'));
    const file = path.join(dir, 'capability.env');
    nodeFs.writeFileSync(file, 'sentinel');
    try {
      const root = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, HOME: dir, GIT_OPTIONAL_LOCKS: '0' },
      }).trim().split('\n')[0];
      const h = setup({ support: (_dir, sha) => preflightSupport(process.cwd(), sha) });
      h.head(root);
      expect(h.gate.evaluate().waiting_on.preflight).toEqual({ error: 'mode unsupported at HEAD' });
      await h.flush();
      expect(h.preflight).not.toHaveBeenCalled();
      expect(nodeFs.readFileSync(file, 'utf8')).toBe('sentinel');
    } finally { nodeFs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('skips preflight while code fails and schedules it when code clears', async () => {
    const h = setup();
    h.dirty(' M index.js');
    expect(h.gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
    expect(h.preflight).not.toHaveBeenCalled();
    h.dirty('');
    expect(h.gate.evaluate().would_pass).toBe(false);
    await h.flush();
    expect(h.gate.evaluate().would_pass).toBe(true);
  });
  it('invalidates the cache when environment bytes or dependency identity change', async () => {
    const h = setup({ landedRef: 'landed', state: { ...empty(), boot_sha: 'new' } });
    h.preflight.mockImplementation(async () => ({ ok: !h.fs.readFileSync('checkout/.env').includes('broken'), error: 'invalid config' }));
    await h.good();
    h.env('broken');
    expect(h.gate.evaluate({ request: {} }).waiting_on.preflight).toEqual({ unknown: true });
    await h.flush();
    expect(h.gate.evaluate({ request: {} }).waiting_on.preflight).toEqual({ error: 'invalid config' });
    h.env('VALID=yes');
    await h.good();
    h.stamp(2);
    expect(h.gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
    await h.good();
    h.fs.statSync.mockReturnValue({ ino: 3, mtimeMs: 2 });
    expect(h.gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
    await h.good();
    h.fs.statSync.mockReturnValue({ ino: 3, mtimeMs: 3 });
    expect(h.gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
    await h.good();
    h.fs.readFileSync.mockImplementation(file => file.endsWith('.env') ? 'VALID=yes' : 'changed lock');
    expect(h.gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
    await h.good();
    h.preflight.mockResolvedValue({ ok: true });
    h.fs.readFileSync.mockImplementation(file => {
      if (file.endsWith('.env')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return 'changed lock';
    });
    expect(h.gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
    await h.flush();
    expect(h.gate.evaluate().would_pass).toBe(true);
  });
  it('expires results at five minutes and warns once per failed run', async () => {
    const h = setup();
    h.preflight.mockResolvedValue({ ok: false, error: 'invalid config' });
    await h.good();
    h.time(5 * minute - 1);
    expect(h.gate.evaluate().waiting_on.preflight).toEqual({ error: 'invalid config' });
    expect(h.warn).toHaveBeenCalledOnce();
    h.preflight.mockResolvedValue({ ok: true });
    h.time(5 * minute);
    expect(h.gate.evaluate().waiting_on.preflight).toEqual({ unknown: true });
    await h.flush();
    expect(h.gate.evaluate().would_pass).toBe(true);
    h.time(10 * minute + 1);
    expect(h.gate.evaluate().would_pass).toBe(false);
  });
  it('keeps dry runs byte-identical while populating the cache', async () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'restart-state-'));
    const file = path.join(dir, 'state.json');
    try {
      const store = createPlannedRestartState({ file, historyFile: path.join(dir, 'history.jsonl') });
      store.persistBootSha('old');
      const before = nodeFs.readFileSync(file);
      const addRequest = vi.spyOn(store, 'addRequest');
      const setState = vi.spyOn(store, 'setState');
      const h = setup({ stateStore: store });
      expect(h.gate.evaluate({ dryRun: true, request: { sha: 'old' } }).waiting_on.preflight).toEqual({ unknown: true });
      await h.flush();
      expect(h.gate.evaluate({ dryRun: true, request: { sha: 'old' } }).would_pass).toBe(true);
      expect(nodeFs.readFileSync(file)).toEqual(before);
      expect(addRequest).not.toHaveBeenCalled();
      expect(setState).not.toHaveBeenCalled();
    } finally { nodeFs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('returns exactly the verdict schema and ignores collection and notices for would_pass', async () => {
    const h = setup({ state: pending(), sessions: () => [{ alive: true, journalConvoId: 'alice' }, { alive: false, journalConvoId: 'bob' }] });
    const result = await h.good({ dryRun: true });
    expect(result).toEqual({ would_pass: true, waiting_on: {
      quiet: { holders: [], probe_error: null }, code: null, preflight: null,
      collect: { remaining_ms: minute }, unwarned: ['alice'],
    } });
    h.dirty(' M index.js');
    expect(h.gate.evaluate({ dryRun: true }).would_pass).toBe(false);
  });
  it('reads code and preflight inputs once per tick and leaves rechecks to the latch', async () => {
    const h = setup({ state: pending(), collectMs: 0 });
    await h.good();
    h.git.mockClear(); h.fs.readFileSync.mockClear(); h.fs.statSync.mockClear();
    h.gate.tick();
    expect(h.onReady).toHaveBeenCalledOnce();
    expect(h.git.mock.calls.filter(([args]) => args[0] === 'rev-parse')).toHaveLength(1);
    expect(h.git.mock.calls.filter(([args]) => args[0] === 'status')).toHaveLength(1);
    expect(h.fs.statSync).toHaveBeenCalledOnce();
    expect(h.fs.readFileSync.mock.calls.filter(([file]) => file.endsWith('package-lock.json'))).toHaveLength(1);
  });
  it('shares ancestry probes for duplicate requests within an evaluation', async () => {
    const h = setup({ state: { ...pending(), requests: [{ sha: 'old' }, { sha: 'old' }] }, collectMs: 0 });
    await h.good();
    h.git.mockClear();
    h.gate.tick();
    expect(h.git.mock.calls.filter(([args]) => args[0] === 'merge-base')).toHaveLength(1);
  });
  it('keeps a running preflight cached across a non-descendant dry run', async () => {
    let finish;
    const preflight = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const h = setup({ preflight });
    h.gate.evaluate();
    expect(h.gate.evaluate({ dryRun: true, request: { sha: 'future' } }).waiting_on.code).toBe('not a descendant');
    finish({ ok: true });
    await h.flush();
    expect(h.gate.evaluate().would_pass).toBe(true);
    expect(preflight).toHaveBeenCalledOnce();
  });
  it('fails closed on unavailable probes, git, state, inputs and preflight exceptions', async () => {
    const h = setup();
    await h.good();
    h.quiet({ quiet: false, holders: [], probe_error: 'process_table' });
    expect(h.gate.evaluate().would_pass).toBe(false);
    const cases = [
      { git: () => { throw new Error('timeout'); } },
      { stateStore: { getState: () => { throw new Error('unreadable'); } } },
      { fs: { readFileSync: () => { throw new Error('unreadable'); } } },
      { support: () => { throw new Error('unavailable'); } },
      { preflight: () => { throw new Error('timeout'); } },
      { preflight: async () => { throw new Error('timeout'); } },
      { preflight: async () => undefined },
    ];
    cases.push(
      { git: args => args[0] === 'rev-parse' ? null : '' },
      { stateStore: { getState: () => null } },
      { state: { ...pending(), first_request_at: null } },
      { quietEvaluator: () => null },
      { quietEvaluator: () => { throw new Error('unavailable'); } },
      { sessions: () => { throw new Error('unavailable'); }, state: pending() },
      { fs: { readFileSync: () => 'valid', statSync: () => { throw new Error('unreadable'); } } },
      { fs: { readFileSync: () => 'valid', statSync: () => ({ ino: null, mtimeMs: 1 }) } },
      { fs: { readFileSync: () => 'valid', statSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } } },
      { fs: { readFileSync: () => { throw Object.assign(new Error('missing lock'), { code: 'ENOENT' }); } } },
    );
    for (const options of cases) expect((await setup(options).good()).would_pass).toBe(false);
  });
  it('holds real ticks until quiet is confirmed and all notices are delivered', async () => {
    const h = setup({ state: pending(), collectMs: 0, sessions: () => [{ alive: true, journalConvoId: 'alice' }] });
    await h.good();
    h.gate.tick();
    expect(h.onReady).not.toHaveBeenCalled();
    h.state({ ...pending(), notified: { alice: true } });
    h.quiet({ quiet: false, holders: [], probe_error: null });
    h.gate.tick();
    expect(h.onReady).not.toHaveBeenCalled();
    h.quiet({ quiet: true, holders: [], probe_error: null });
    h.dirty(' M index.js');
    expect(h.gate.tick().would_pass).toBe(false);
    h.dirty('');
    h.gate.tick();
    await h.flush();
    h.gate.tick();
    expect(h.onReady).toHaveBeenCalledOnce();
  });
  it('preserves verdict invariants across ancestry, cleanliness, collection and notices', async () => {
    for (const sha of ['old', 'new', 'future']) for (const dirty of ['', ' M index.js']) {
      const h = setup({ state: pending(), sessions: () => [{ alive: true, journalConvoId: 'alice' }] });
      h.state({ ...pending(), requests: [{ sha }] });
      h.dirty(dirty);
      const first = await h.good();
      expect(first.would_pass).toBe(sha !== 'future' && !dirty);
      h.time(minute);
      expect(h.gate.evaluate().would_pass).toBe(first.would_pass);
      h.state({ ...pending(), last_request_at: minute, notified: { alice: true }, requests: [{ sha }] });
      expect(h.gate.evaluate({ dryRun: true }).would_pass).toBe(first.would_pass);
      if (first.would_pass) expect(h.git(['merge-base', '--is-ancestor', sha, 'new'])).toBe(true);
    }
  });
});
