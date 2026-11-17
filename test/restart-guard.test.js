import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInputCounter, createKeyStore, createRestartGuard } from '../lib/restart-guard.js';
import { createCodeUpdateWatcher } from '../lib/code-update-restart.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

// A fake git: HEAD, the shas that are ancestors of it, and a dirty flag.
function fakeGit(state) {
  return args => {
    if (args[0] === 'rev-parse') return `${state.head}\n`;
    if (args[0] === 'merge-base') return args[3] === 'origin/master' ? state.landed !== false : state.ancestors.has(args[2]);
    if (args[0] === 'status') return state.dirty ? ' M index.js\n' : '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function setup(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-guard-'));
  roots.push(root);
  const git = { head: SHA, ancestors: new Set([SHA]), dirty: false, ...options.git };
  let requested = null;
  const watcher = options.noWatcher ? null : {
    get requested() { return requested ? { ...requested } : null; },
    gateHoldReason: null,
    request: vi.fn(({ reason, by }) => { requested = { reason, by, at: 1, error: null }; return { ok: true, requested }; }),
    restarting: false,
    cancelRequest: vi.fn(() => { const had = !!requested; requested = null; return had; }),
  };
  const onChange = vi.fn();
  const keys = createKeyStore({ file: path.join(root, 'keys.json'), now: () => options.now?.() ?? 1000 });
  const guard = createRestartGuard({
    getWatcher: () => watcher, repoDir: root, bootSha: options.bootSha === undefined ? SHA : options.bootSha,
    holds: () => options.holds?.() ?? { holders: [], unreadable: false },
    liveConvoIds: () => options.live ?? [], occupied: o => options.occupied?.(o) ?? [], collectMs: options.collectMs ?? 0, preflight: options.preflight, preflightKey: options.preflightKey,
    commandGate: options.commandGate ?? null, landedRef: options.landedRef ?? null, keys, git: fakeGit(git), now: options.clock ?? (() => 1000), onChange,
  });
  return { guard, git, watcher, keys, onChange, root };
}
const post = (guard, body) => guard.handle({ method: 'POST', body });

describe('key store', () => {
  it('remembers a key, forgets it after the TTL and bounds the file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-keys-'));
    roots.push(root);
    let t = 0;
    const store = createKeyStore({ file: path.join(root, 'k.json'), now: () => t });
    expect(store.has('a')).toBe(false);
    store.add('a');
    expect(store.has('a')).toBe(true);
    t = 8 * 24 * 3600_000;
    expect(store.has('a')).toBe(false);
    for (let i = 0; i < 250; i++) { t += 1; store.add(`k${i}`); }
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'k.json'), 'utf8')))).toHaveLength(200);
    expect(store.has('k249')).toBe(true);
    expect(store.has('k0')).toBe(false);
    expect(fs.statSync(path.join(root, 'k.json')).mode & 0o777).toBe(0o600);
  });

  it('treats a corrupt file as empty and rewrites it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-keys-'));
    roots.push(root);
    const file = path.join(root, 'k.json');
    fs.writeFileSync(file, '{not json');
    const store = createKeyStore({ file, now: () => 5 });
    expect(store.has('a')).toBe(false);
    store.add('a');
    expect(store.has('a')).toBe(true);
  });
});

describe('request admission', () => {
  it('asks the upstream watcher and answers 202 with the id and the pinned requests', async () => {
    const h = setup();
    const r = await post(h.guard, { reason: 'deploy', sha: SHA, request_key: 'k1' });
    expect(r.status).toBe(202);
    expect(h.watcher.request).toHaveBeenCalledWith({ reason: 'deploy', by: 'operator' });
    expect(r.body.id).toBeTruthy();
    expect(r.body.requests).toEqual([{ reason: 'deploy', sha: SHA }]);
    expect(h.onChange).toHaveBeenCalledOnce();
    expect(h.guard.pending()).toBe(true);
    expect(h.guard.getState()).toMatchObject({ state: 'pending', requests: [{ reason: 'deploy', sha: SHA }] });
  });

  it.each([
    [{}, /reason is required/],
    [{ reason: '   ' }, /reason is required/],
    [{ reason: 'x', sha: '--upload-pack=x' }, /sha must be a hex commit id/],
    [{ reason: 'x', sha: 'main' }, /sha must be a hex commit id/],
    [{ reason: 'x', sha: 12 }, /sha must be a hex commit id/],
    [{ reason: 'x', request_key: '' }, /request_key/],
    [{ reason: 'x', request_key: 'k'.repeat(201) }, /request_key/],
  ])('rejects %j with 400 before asking the watcher', async (body, message) => {
    const h = setup();
    const r = await post(h.guard, body);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(message);
    expect(h.watcher.request).not.toHaveBeenCalled();
  });

  it('refuses a sha that is not an ancestor of HEAD with 409', async () => {
    const h = setup();
    const r = await post(h.guard, { reason: 'deploy', sha: OTHER });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'not a descendant' });
    expect(h.watcher.request).not.toHaveBeenCalled();
    expect(h.guard.pending()).toBe(false);
  });

  it('refuses a config-only request once HEAD has moved since boot, and takes it before', async () => {
    const moved = setup({ bootSha: SHA, git: { head: OTHER } });
    const r = await post(moved.guard, { reason: 'reload config' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('head moved (config-only)');
    const fine = setup();
    expect((await post(fine.guard, { reason: 'reload config' })).status).toBe(202);
  });

  it('refuses a config-only request when the boot sha is unknown', async () => {
    const h = setup({ bootSha: null });
    expect((await post(h.guard, { reason: 'reload config' })).status).toBe(409);
  });

  it('is idempotent on request_key, including after a restart of the process', async () => {
    const h = setup();
    expect((await post(h.guard, { reason: 'deploy', sha: SHA, request_key: 'k1' })).status).toBe(202);
    const again = await post(h.guard, { reason: 'deploy', sha: SHA, request_key: 'k1' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ idempotent: true, request_key: 'k1' });
    expect(h.watcher.request).toHaveBeenCalledOnce();
    // A new process over the same key file: the retry is still recognised and
    // nothing is requested, so a client retrying after the restart cannot
    // restart the bridge a second time.
    const next = setup();
    fs.copyFileSync(path.join(h.root, 'keys.json'), path.join(next.root, 'keys.json'));
    expect((await post(next.guard, { reason: 'deploy', sha: SHA, request_key: 'k1' })).status).toBe(200);
    expect(next.watcher.request).not.toHaveBeenCalled();
  });

  it('records no key for a refused request', async () => {
    const h = setup();
    await post(h.guard, { reason: 'deploy', sha: OTHER, request_key: 'k2' });
    expect(h.keys.has('k2')).toBe(false);
  });

  it('merges a second request: both pins stay, one watcher request, the first time kept', async () => {
    const h = setup();
    await post(h.guard, { reason: 'one', sha: SHA });
    const r = await post(h.guard, { reason: 'two' });
    expect(r.status).toBe(202);
    expect(r.body.requests).toEqual([{ reason: 'one', sha: SHA }, { reason: 'two' }]);
  });

  it('answers 503 (retry after back) when the watcher is off, without recording anything', async () => {
    const h = setup({ noWatcher: true });
    const r = await post(h.guard, { reason: 'deploy', sha: SHA, request_key: 'k3' });
    expect(r.status).toBe(503);
    expect(h.keys.has('k3')).toBe(false);
  });
});

describe('cancel and dry run', () => {
  it('DELETE withdraws the request and clears the pins and the notice state', async () => {
    const h = setup();
    await post(h.guard, { reason: 'deploy', sha: SHA });
    const id = h.guard.getState().id;
    h.guard.markNotified(id, 'alice');
    const r = await h.guard.handle({ method: 'DELETE' });
    expect(r).toMatchObject({ status: 200, body: { cancelled: true } });
    expect(h.guard.pending()).toBe(false);
    expect(h.guard.getState()).toEqual({ id: null, state: null, requests: [], notified: {} });
    expect(h.onChange).toHaveBeenCalledTimes(2);
    expect((await h.guard.handle({ method: 'DELETE' })).body.cancelled).toBe(false);
  });

  it('GET reports the requests, the holders and what the restart is waiting on', async () => {
    const h = setup({ live: ['alice'], holds: () => ({ holders: [{ session: { roomId: '!r:x' }, reason: 'turn in progress' }], unreadable: false }) });
    await post(h.guard, { reason: 'deploy', sha: SHA });
    const r = await h.guard.handle({ method: 'GET' });
    expect(r.status).toBe(200);
    expect(r.body.requests).toEqual([{ reason: 'deploy', sha: SHA }]);
    expect(r.body.holders).toEqual([{ roomId: '!r:x', reason: 'turn in progress' }]);
    expect(r.body.waiting_on).toMatchObject({ code: null, collect: null, unwarned: ['alice'] });
    expect(r.body.waiting_on.quiet.holders).toEqual([{ convoId: '!r:x', why: 'turn in progress' }]);
    expect(h.guard.lastVerdict).toEqual({ waiting_on: r.body.waiting_on });
  });
});

describe('landed ref', () => {
  it('refuses a request while HEAD has not landed, and accepts it once it has', async () => {
    const h = setup({ landedRef: 'origin/master', git: { landed: false } });
    const r = await post(h.guard, { reason: 'deploy', sha: SHA });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('head not landed');
    expect(h.watcher.request).not.toHaveBeenCalled();
    h.git.landed = true;
    expect((await post(h.guard, { reason: 'deploy', sha: SHA })).status).toBe(202);
  });

  it('holds the gate on an unlanded HEAD even with no request behind it (an automatic update)', async () => {
    const h = setup({ landedRef: 'origin/master', git: { landed: false } });
    expect(await h.guard.gate()).toEqual({ hold: true, reason: 'head not landed' });
    h.git.landed = true;
    expect(await h.guard.gate()).toEqual({ hold: false });
  });

  it('does not look at landing when no ref is configured', async () => {
    const h = setup({ git: { landed: false } });
    expect(await h.guard.gate()).toEqual({ hold: false });
  });

  it('fails closed on a ref that looks like a git option, without running git on it', async () => {
    const h = setup({ landedRef: '--upload-pack=x' });
    expect((await post(h.guard, { reason: 'deploy', sha: SHA })).body.code).toBe('head not landed');
    expect(await h.guard.gate()).toEqual({ hold: true, reason: 'head not landed' });
  });
});

describe('gate', () => {
  it('holds while HEAD no longer descends from a pinned sha, and lets go when it does', async () => {
    const h = setup();
    await post(h.guard, { reason: 'deploy', sha: SHA });
    h.git.ancestors.clear();
    expect(await h.guard.gate()).toEqual({ hold: true, reason: 'not a descendant' });
    h.git.ancestors.add(SHA);
    expect(await h.guard.gate()).toEqual({ hold: false });
  });

  it('holds a config-only request once HEAD moves and a dirty tree', async () => {
    const h = setup();
    await post(h.guard, { reason: 'reload config' });
    h.git.head = OTHER;
    expect(await h.guard.gate()).toEqual({ hold: true, reason: 'head moved (config-only)' });
    h.git.head = SHA;
    h.git.dirty = true;
    expect(await h.guard.gate()).toEqual({ hold: true, reason: 'dirty tree' });
  });

  it('holds until every live session has been told, then lets go', async () => {
    const h = setup({ live: ['alice', 'bob'] });
    await post(h.guard, { reason: 'deploy', sha: SHA });
    const id = h.guard.getState().id;
    expect((await h.guard.gate()).reason).toMatch(/2 session\(s\) not yet told/);
    h.guard.markNotified(id, 'alice');
    expect((await h.guard.gate()).reason).toMatch(/1 session\(s\) not yet told/);
    h.guard.markNotified(id, 'bob');
    expect(await h.guard.gate()).toEqual({ hold: false });
  });

  it('holds on in-memory input holds with no request, and consults the operator command last', async () => {
    const commandGate = vi.fn(async () => ({ hold: true, reason: 'operator says wait' }));
    let busy = [{ convoId: 'alice', why: 'queued_input' }];
    const h = setup({ occupied: () => busy, commandGate });
    expect((await h.guard.gate()).reason).toMatch(/1 session\(s\) with input pending \(queued_input\)/);
    expect(commandGate).not.toHaveBeenCalled();
    busy = [];
    expect(await h.guard.gate()).toEqual({ hold: true, reason: 'operator says wait' });
    expect(commandGate).toHaveBeenCalledOnce();
  });
});

describe('notice state', () => {
  it('records the first notification and the end of the notice turn, and ignores stale writes', async () => {
    const h = setup();
    await post(h.guard, { reason: 'deploy', sha: SHA });
    const id = h.guard.getState().id;
    h.guard.markNotified('stale', 'alice');
    h.guard.markNotified(id, null);
    expect(h.guard.getState().notified).toEqual({});
    h.guard.markNotified(id, 'alice');
    h.guard.markNoticeTurnEnded(id, 'bob');
    h.guard.markNoticeTurnEnded(id, 'alice');
    h.guard.markNotified(id, 'alice');
    expect(h.guard.getState().notified).toEqual({ alice: { at: 1000, turnEnded: true } });
  });

  it('has no state without a request', () => {
    const h = setup();
    h.guard.markNotified('x', 'alice');
    expect(h.guard.getState().state).toBeNull();
  });
});

describe('input counter', () => {
  it('counts inputs in flight and tolerates a double end', () => {
    const inputs = createInputCounter();
    const a = inputs.begin();
    const b = inputs.begin();
    expect(inputs.count).toBe(2);
    a(); a();
    expect(inputs.count).toBe(1);
    b();
    expect(inputs.count).toBe(0);
  });
});

describe('with the upstream watcher', () => {
  // Never forced: a hold from the gate does not lapse (gateMaxMs: Infinity in
  // index.js), however long it lasts, while upstream's default would let it go
  // after the work-hold cap and restart onto sessions the gate still holds.
  function wired(gateMaxMs) {
    const h = setup();
    let clock = 10_000_000;
    let live = ['alice'];
    const restart = vi.fn();
    let guard;
    const watcher = createCodeUpdateWatcher({
      readHead: () => ({ sha: SHA, at: 1 }), busySessions: () => 0, preflight: async () => ({ ok: true }), restart,
      gate: () => guard.gate(), gateMaxMs, now: () => clock, bootSha: SHA, warn: () => {}, log: () => {},
    });
    guard = createRestartGuard({
      getWatcher: () => watcher, repoDir: h.root, bootSha: SHA, holds: () => ({ holders: [], unreadable: false }),
      liveConvoIds: () => live, keys: h.keys, git: fakeGit(h.git), now: () => clock,
    });
    return { guard, watcher, restart, advance: ms => { clock += ms; }, setLive: v => { live = v; } };
  }
  const HOUR = 3600_000;

  it('does not restart while the notice is outstanding, even long past the work-hold cap, then restarts once told', async () => {
    const w = wired(Infinity);
    expect((await post(w.guard, { reason: 'deploy', sha: SHA })).status).toBe(202);
    expect((await w.watcher.tick()).action).toBe('waiting');
    w.advance(9 * HOUR);
    expect((await w.watcher.tick()).action).toBe('waiting');
    expect(w.restart).not.toHaveBeenCalled();
    expect(w.watcher.gateHoldReason).toMatch(/not yet told/);
    w.guard.markNotified(w.guard.getState().id, 'alice');
    expect((await w.watcher.tick()).action).toBe('restart');
    expect(w.restart).toHaveBeenCalledOnce();
    expect(w.restart.mock.calls[0][0]).toMatchObject({ forced: false, sha: SHA });
  });

  it('shows what the cap does: upstream default lets the hold lapse', async () => {
    const w = wired(8 * HOUR);
    await post(w.guard, { reason: 'deploy', sha: SHA });
    await w.watcher.tick();
    w.advance(9 * HOUR);
    expect((await w.watcher.tick()).action).toBe('restart');
  });

  it('a cancelled request restarts nothing, and a new one starts clean', async () => {
    const w = wired(Infinity);
    await post(w.guard, { reason: 'deploy', sha: SHA });
    await w.watcher.tick();
    expect((await w.guard.handle({ method: 'DELETE' })).body.cancelled).toBe(true);
    w.advance(HOUR);
    expect((await w.watcher.tick()).action).toBe('none');
    expect(w.restart).not.toHaveBeenCalled();
    w.setLive([]);
    await post(w.guard, { reason: 'again', sha: SHA });
    expect((await w.watcher.tick()).action).toBe('restart');
  });
});
