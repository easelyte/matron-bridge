import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeyStore, createRestartGuard } from '../lib/restart-guard.js';
import { createCodeUpdateWatcher } from '../lib/code-update-restart.js';
import { evaluateQuiet } from '../lib/restart-quiet.js';
import { restartPreflightKey } from '../lib/restart-preflight.js';

// Fixes from the independent review of the restart sync.
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const SHA = 'a'.repeat(40);
const HOUR = 3600_000;

function fakeGit(state = {}) {
  return args => {
    if (args[0] === 'rev-parse') return `${state.head ?? SHA}\n`;
    if (args[0] === 'merge-base') return true;
    if (args[0] === 'status') return '';
    throw new Error('unexpected git');
  };
}

// A real watcher and a real guard over it, with a clock and recorded restarts.
function wired(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-review-'));
  roots.push(root);
  const clock = { t: 10_000_000 };
  const restart = vi.fn();
  const calls = [];
  let busy = options.busy ?? 0;
  let guard;
  const watcher = createCodeUpdateWatcher({
    readHead: () => ({ sha: SHA, at: 1 }),
    busySessions: () => busy + (options.occupiedNow ? options.occupiedNow().length : 0),
    preflight: async () => ({ ok: true }), restart,
    gate: () => guard.gate(), gateMaxMs: Infinity, now: () => clock.t, bootSha: SHA, warn: () => {}, log: () => {},
  });
  guard = createRestartGuard({
    getWatcher: () => watcher, repoDir: root, bootSha: SHA, holds: () => ({ holders: [], unreadable: false }),
    liveConvoIds: () => [], occupied: o => { calls.push(o); return options.occupied?.(o) ?? []; },
    commandGate: options.commandGate ?? null, collectMs: options.collectMs ?? 0,
    preflight: options.preflight, preflightKey: options.preflightKey,
    keys: createKeyStore({ file: path.join(root, 'keys.json'), now: () => clock.t }), git: fakeGit(), now: () => clock.t,
  });
  return { guard, watcher, restart, clock, calls, setBusy: v => { busy = v; } };
}
const post = (guard, body) => guard.handle({ method: 'POST', body });

describe('finding 4: only the gate counts quiet readings, and a read has no side effect', () => {
  it('asks occupied() with gate:true only from the gate, gate:false from GET', async () => {
    const w = wired();
    await post(w.guard, { reason: 'deploy', sha: SHA });
    w.calls.length = 0;
    await w.guard.handle({ method: 'GET' });
    w.guard.evaluate();
    w.guard.occupiedNow();
    expect(w.calls.length).toBeGreaterThan(0);
    expect(w.calls.every(o => o.gate === false)).toBe(true);
    w.calls.length = 0;
    await w.guard.gate();
    expect(w.calls).toEqual([{ gate: true }]);
  });

  it('a read-only evaluateQuiet leaves the Codex worker groups and background children as they were', () => {
    const group = { pid: 10, pgid: 10, sid: 10, startTime: 'gone' };
    const session = { alive: true, codex: { transport: 'exec', child: null, workGroups: [group] }, _bgWorkChildren: [{ pid: 5, startTime: 'x' }] };
    const options = { sessions: [session], bootAt: 0, readProcessTable: () => ({ ok: true, table: [{ pid: 1, ppid: 0, pgid: 1, sid: 1, startTime: 's' }] }), listRunningSubagents: () => [] };
    const groupsBefore = [...session.codex.workGroups];
    const bgBefore = [...session._bgWorkChildren];
    evaluateQuiet({ ...options, readOnly: true });
    expect(session.codex.workGroups).toEqual(groupsBefore);
    expect(session.codex.workGroups).toEqual([group]);
    expect(session._bgWorkChildren).toEqual(bgBefore);
    // The counting evaluation is the one that updates the inventory.
    evaluateQuiet(options);
    expect(session.codex.workGroups).toEqual([]);
  });

  it('a read-only evaluation does not add a field a session never had', () => {
    const session = { alive: true };
    evaluateQuiet({ readOnly: true, sessions: [session], bootAt: 0, readProcessTable: () => ({ ok: true, table: [] }), listRunningSubagents: () => [] });
    expect('_bgWorkChildren' in session).toBe(false);
  });

  it('the production wiring counts a reading only on the gate path', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(index).toContain('readOnly: !gate,');
    expect(index).toContain('if (gate) priorQuiet = quiet;');
    expect(index).toContain("if (gate && !out.length && !quiet.quiet) out.push({ convoId: null, why: 'settling' });");
  });
});

describe('finding 6: a request cannot be withdrawn once the process is exiting', () => {
  it('cancelRequest returns false after the restart, DELETE answers 409 and the request stays', async () => {
    const w = wired();
    await post(w.guard, { reason: 'deploy', sha: SHA });
    expect((await w.watcher.tick()).action).toBe('restart');
    expect(w.watcher.restarting).toBe(true);
    expect(w.watcher.cancelRequest()).toBe(false);
    expect(w.watcher.requested).not.toBeNull();
    const r = await w.guard.handle({ method: 'DELETE' });
    expect(r).toEqual({ status: 409, body: { error: 'restarting' } });
    expect(w.guard.pending()).toBe(true);
    expect(w.guard.getState().requests).toHaveLength(1);
  });
});

describe('finding 8: 503 when the bridge cannot take it now, 409 for a refused pin', () => {
  it('answers 503 for a watcher that is not running, on every method', async () => {
    const guard = createRestartGuard({ getWatcher: () => null, repoDir: '.', holds: () => ({ holders: [] }), git: fakeGit() });
    for (const method of ['POST', 'GET', 'DELETE']) {
      expect((await guard.handle({ method, body: { reason: 'x' } })).status).toBe(503);
    }
  });

  it('answers 503 for POST and GET while restarting, and keeps 409 for DELETE and for a refused pin', async () => {
    const w = wired();
    await post(w.guard, { reason: 'deploy', sha: SHA });
    await w.watcher.tick();
    expect((await post(w.guard, { reason: 'again', sha: SHA })).status).toBe(503);
    expect((await w.guard.handle({ method: 'GET' })).status).toBe(503);
    expect((await w.guard.handle({ method: 'DELETE' })).status).toBe(409);
    const refusing = createRestartGuard({
      getWatcher: () => ({ requested: null, restarting: false, request: () => ({ ok: true }) }), repoDir: '.', bootSha: SHA,
      holds: () => ({ holders: [] }), git: args => (args[0] === 'rev-parse' ? `${SHA}\n` : false),
    });
    expect((await post(refusing, { reason: 'x', sha: 'b'.repeat(40) })).status).toBe(409);
  });
});

describe('finding 12: force-after is pinned to 0', () => {
  it('passes forceAfterMs: 0 to the watcher whatever the environment says', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const start = index.indexOf('function startCodeUpdateWatcher() {');
    const fn = index.slice(start, index.indexOf('\n}\n', start));
    expect(fn).toMatch(/forceAfterMs: 0,/);
    expect(fn).not.toMatch(/forceAfterMs: CODE_UPDATE_FORCE_AFTER_MS/);
    expect(fn).toContain('MATRON_CODE_UPDATE_FORCE_AFTER_MS is ignored in this fork');
  });

  it('a watcher with forceAfterMs 0 never restarts onto a running turn, however long it waits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-force-'));
    roots.push(root);
    let t = 10_000_000;
    const restart = vi.fn();
    const watcher = createCodeUpdateWatcher({
      readHead: () => ({ sha: SHA, at: 1 }), busySessions: () => 1, preflight: async () => ({ ok: true }), restart,
      forceAfterMs: 0, now: () => t, bootSha: SHA, warn: () => {}, log: () => {},
    });
    watcher.request({ reason: 'x' });
    await watcher.tick();
    t += 48 * HOUR;
    expect((await watcher.tick()).action).toBe('waiting');
    expect(restart).not.toHaveBeenCalled();
  });
});

describe('finding 10: a cancelled request forgets its key', () => {
  it('lets the same request_key ask again after DELETE', async () => {
    const w = wired();
    expect((await post(w.guard, { reason: 'deploy', sha: SHA, request_key: 'k1' })).status).toBe(202);
    expect((await post(w.guard, { reason: 'deploy', sha: SHA, request_key: 'k1' })).status).toBe(200);
    expect((await w.guard.handle({ method: 'DELETE' })).body.cancelled).toBe(true);
    expect((await post(w.guard, { reason: 'deploy', sha: SHA, request_key: 'k1' })).status).toBe(202);
  });

  it('a key that is not cancelled stays remembered', async () => {
    const w = wired();
    await post(w.guard, { reason: 'deploy', sha: SHA, request_key: 'keep' });
    await w.guard.handle({ method: 'DELETE' });
    await post(w.guard, { reason: 'other', sha: SHA, request_key: 'other' });
    expect((await post(w.guard, { reason: 'other', sha: SHA, request_key: 'other' })).status).toBe(200);
  });
});

describe('finding 11: the check after the gate command covers the whole quiet rule', () => {
  it('does not restart when an in-memory hold appears while the gate command runs', async () => {
    let held = false;
    let gateCalls = 0;
    const w = wired({
      occupiedNow: () => (held ? [{ convoId: 'alice', why: 'queued_input' }] : []),
      commandGate: async () => { if (gateCalls++ === 0) held = true; return { hold: false }; },
    });
    await post(w.guard, { reason: 'deploy', sha: SHA });
    const r = await w.watcher.tick();
    expect(r.action).toBe('waiting');
    expect(w.restart).not.toHaveBeenCalled();
    held = false;
    expect((await w.watcher.tick()).action).toBe('restart');
  });

  it('wires the busy count to the side-effect-free in-memory read', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(index).toContain('busySessions: () => sessionsHoldingRestart().holders.length + restartGuard.occupiedNow().length,');
  });
});

describe('finding 9: requests close together are one restart', () => {
  it('waits for the collect window after the last request, and a later request extends it', async () => {
    const w = wired({ collectMs: 60_000 });
    await post(w.guard, { reason: 'one', sha: SHA });
    expect((await w.watcher.tick()).action).toBe('waiting');
    expect(w.watcher.gateHoldReason).toMatch(/collecting requests, 60s left/);
    w.clock.t += 40_000;
    await post(w.guard, { reason: 'two', sha: SHA });
    w.clock.t += 40_000;
    expect((await w.watcher.tick()).action).toBe('waiting');
    expect(w.restart).not.toHaveBeenCalled();
    const verdict = w.guard.evaluate();
    expect(verdict.waiting_on.collect).toEqual({ remaining_ms: 20_000 });
    w.clock.t += 20_000;
    expect((await w.watcher.tick()).action).toBe('restart');
    expect(w.restart).toHaveBeenCalledOnce();
    expect(w.restart.mock.calls[0][0].requested.reason).toBe('two');
    expect(w.guard.getState().requests).toHaveLength(2);
  });

  it('never waits more than 30 minutes after the first request', async () => {
    const w = wired({ collectMs: 10 * 60_000 });
    await post(w.guard, { reason: 'one', sha: SHA });
    for (let i = 0; i < 3; i++) {
      w.clock.t += 9 * 60_000;
      await post(w.guard, { reason: `again ${i}`, sha: SHA });
      await w.watcher.tick();
    }
    expect(w.restart).not.toHaveBeenCalled();
    w.clock.t += 3 * 60_000;
    expect((await w.watcher.tick()).action).toBe('restart');
  });

  it('with no window a request goes as soon as it is quiet', async () => {
    const w = wired();
    await post(w.guard, { reason: 'one', sha: SHA });
    expect((await w.watcher.tick()).action).toBe('restart');
  });
});

describe('finding 7: the preflight runs again right before the restart', () => {
  const keyOf = (over = {}) => ({ sha: SHA, env_hash: 'e', deps_stamp: 'd', ...over });

  it('runs it once for the same inputs within 5 minutes, and again after the TTL or a changed input', async () => {
    const preflight = vi.fn(async () => ({ ok: true }));
    let key = keyOf();
    const w = wired({ preflight, preflightKey: () => key });
    expect(await w.guard.gate()).toEqual({ hold: false });
    expect(await w.guard.gate()).toEqual({ hold: false });
    expect(preflight).toHaveBeenCalledOnce();
    key = keyOf({ env_hash: 'changed' });
    await w.guard.gate();
    expect(preflight).toHaveBeenCalledTimes(2);
    await w.guard.gate();
    expect(preflight).toHaveBeenCalledTimes(2);
    w.clock.t += 5 * 60_000;
    await w.guard.gate();
    expect(preflight).toHaveBeenCalledTimes(3);
    key = keyOf({ deps_stamp: 'reinstalled' });
    await w.guard.gate();
    expect(preflight).toHaveBeenCalledTimes(4);
  });

  it('holds with a fixed reason when it fails, and does not restart; it is retried after the TTL', async () => {
    let ok = false;
    const preflight = vi.fn(async () => ({ ok, error: 'credential-sentinel in stderr' }));
    const w = wired({ preflight, preflightKey: () => keyOf() });
    await post(w.guard, { reason: 'deploy', sha: SHA });
    const r = await w.watcher.tick();
    expect(r.action).toBe('waiting');
    expect(w.watcher.gateHoldReason).toBe('preflight failed');
    expect(JSON.stringify([w.watcher.gateHoldReason, w.guard.evaluate()])).not.toContain('credential-sentinel');
    expect(w.restart).not.toHaveBeenCalled();
    ok = true;
    await w.watcher.tick();
    expect(w.restart).not.toHaveBeenCalled();
    w.clock.t += 5 * 60_000;
    expect((await w.watcher.tick()).action).toBe('restart');
  });

  it('is not asked while the command gate or another hold still says wait', async () => {
    const preflight = vi.fn(async () => ({ ok: true }));
    const w = wired({ preflight, preflightKey: () => keyOf(), commandGate: async () => ({ hold: true, reason: 'wait' }) });
    expect(await w.guard.gate()).toEqual({ hold: true, reason: 'wait' });
    expect(preflight).not.toHaveBeenCalled();
  });

  it('runs the preflight when its inputs cannot be read', async () => {
    const preflight = vi.fn(async () => ({ ok: true }));
    const w = wired({ preflight, preflightKey: () => { throw new Error('unreadable'); } });
    await w.guard.gate();
    await w.guard.gate();
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it('keys the result on the commit, the .env and the dependency stamp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-key-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(root, 'node_modules/.package-lock.json'), '{}');
    const git = () => `${SHA}\n`;
    const none = restartPreflightKey(root, { git });
    expect(none).toMatchObject({ sha: SHA, env_hash: 'none' });
    fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
    const withEnv = restartPreflightKey(root, { git });
    expect(withEnv.env_hash).not.toBe('none');
    fs.writeFileSync(path.join(root, '.env'), 'A=2\n');
    expect(restartPreflightKey(root, { git }).env_hash).not.toBe(withEnv.env_hash);
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"x":1}');
    expect(restartPreflightKey(root, { git }).deps_stamp).not.toBe(withEnv.deps_stamp);
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
    expect(() => restartPreflightKey(root, { git })).toThrow();
  });

  it('is wired with the key and the preflight in the production guard', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(index).toContain('preflightKey: () => restartPreflightKey(__dirname),');
    expect(index).toContain("preflight: () => createRestartPreflight(__dirname, { bootDotenvKeys: BOOT_DOTENV_KEYS })(),");
    expect(index).toContain('collectMs: RESTART_COLLECT_MS,');
  });
});
