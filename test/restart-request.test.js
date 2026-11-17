import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRestartRequests, PINNED_WATCHER_OPTIONS } from '../lib/restart-request.js';
import { createCodeUpdateWatcher } from '../lib/code-update-restart.js';
import { createQuietReader } from '../lib/restart-quiet.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);
const T0 = Date.parse('2026-11-17T12:00:00Z');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-request-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const files = () => ({
  stateFile: path.join(dir, 'state.json'),
  historyFile: path.join(dir, 'history.jsonl'),
});
const readState = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

// A repo whose HEAD and ancestry the test controls. contains[head] = shas HEAD includes.
function fakeGit(world) {
  return (args) => {
    if (args[0] === 'rev-parse') return `${world.head}\n`;
    if (args[0] === 'status') return world.dirty ? ' M index.js\n' : '';
    if (args[0] === 'merge-base') {
      const [, , ancestor, descendant] = args;
      if (ancestor === descendant) return true;
      return (world.contains[descendant] || []).includes(ancestor);
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

// A watcher (real) wired to the layer the way index.js wires it.
function build({ head = OLD, bootSha = OLD, busy = 0, quiet = null, commandGate = null, preflight = null, autoUpdate = true, watcherOptions = PINNED_WATCHER_OPTIONS, landedRef = null } = {}) {
  const world = { head, dirty: false, contains: { [NEW]: [OLD], [NEWER]: [OLD, NEW] }, now: T0, busy, holders: [], restarts: [] };
  const git = fakeGit(world);
  let watcher = null;
  const layer = createRestartRequests({
    getWatcher: () => watcher, holds: () => ({ holders: world.holders, unreadable: false }),
    repoDir: dir, bootSha, bootId: 'boot-1', quiet, commandGate, preflight, landedRef,
    ...files(), git, now: () => world.now, warn: () => {}, log: () => {},
  });
  watcher = createCodeUpdateWatcher({
    readHead: () => ({ sha: world.head, at: world.now - 3600_000 }),
    busySessions: () => world.busy,
    preflight: async () => ({ ok: true }),
    restart: (info) => world.restarts.push(info),
    gate: layer.gate, beforeRestart: layer.commitRestart,
    now: () => world.now, bootSha, autoUpdate, ...watcherOptions,
  });
  layer.reconcileBoot();
  return { world, layer, watcher };
}

const post = (layer, body) => layer.handle({ method: 'POST', body });

describe('request admission', () => {
  it('refuses a body without a reason or with a bad sha or key', async () => {
    const { layer } = build();
    expect((await post(layer, {})).status).toBe(400);
    expect((await post(layer, { reason: 'x', sha: '--force' })).status).toBe(400);
    expect((await post(layer, { reason: 'x', sha: NEW, request_key: '' })).status).toBe(400);
  });

  it('answers 409 with upstream\'s message while the watcher is off', async () => {
    const layer = createRestartRequests({ getWatcher: () => null, holds: () => ({ holders: [], unreadable: false }), repoDir: dir, ...files(), git: fakeGit({ head: OLD, contains: {} }) });
    const r = await post(layer, { reason: 'x', sha: NEW });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/code-update watcher is not running/);
  });

  it('accepts a request with a sha and returns upstream\'s state plus id, key and requests', async () => {
    const { layer, watcher } = build({ head: NEW });
    const r = await post(layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ request_key: 'k1', requests: [{ reason: 'deploy', sha: NEW, request_key: 'k1' }] });
    expect(r.body.id).toEqual(expect.any(String));
    expect(r.body).toHaveProperty('holders');
    expect(r.body).toHaveProperty('gate');
    expect(watcher.requested.reason).toBe('deploy');
  });
});

describe('request key idempotence', () => {
  it('the same key returns the same request and asks the watcher once', async () => {
    const { layer, watcher } = build({ head: NEW });
    const first = await post(layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    const asked = watcher.requested.at;
    const again = await post(layer, { reason: 'different words', sha: NEW, request_key: 'k1' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ idempotent: true, id: first.body.id, request_key: 'k1', state: 'pending' });
    expect(watcher.requested.reason).toBe('deploy');
    expect(watcher.requested.at).toBe(asked);
    expect(readState().requests).toHaveLength(1);
  });

  it('still returns the same request after the restart it caused', async () => {
    const a = build({ head: NEW });
    const first = await post(a.layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    a.world.holders = [];
    // The process exits (committed), the next boot reconciles.
    a.layer.commitRestart({ sha: NEW });
    const b = build({ head: NEW, bootSha: NEW });
    const again = await post(b.layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ idempotent: true, id: first.body.id, state: 'back' });
    expect(b.watcher.requested).toBeNull();
  });

  it('a cancelled request forgets its key, so it can be asked for again', async () => {
    const { layer } = build({ head: NEW });
    const first = await post(layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    const cancelled = await layer.handle({ method: 'DELETE' });
    expect(cancelled.body).toEqual({ cancelled: true, id: first.body.id, state: 'cancelled' });
    expect(readState()).toMatchObject({ state: 'cancelled', requests: [] });
    const again = await post(layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    expect(again.status).toBe(202);
    expect(again.body.id).not.toBe(first.body.id);
  });

  it('a second request with another key joins the open request', async () => {
    const { layer } = build({ head: NEW });
    const a = await post(layer, { reason: 'one', sha: NEW, request_key: 'k1' });
    const b = await post(layer, { reason: 'two', sha: NEW, request_key: 'k2' });
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.requests.map(r => r.request_key)).toEqual(['k1', 'k2']);
  });
});

describe('sha pin and config-only requests', () => {
  it('waits until HEAD is the sha or contains it, then restarts', async () => {
    const { layer, watcher, world } = build({ head: OLD });
    expect((await post(layer, { reason: 'deploy', sha: NEW })).status).toBe(202);
    expect(await watcher.tick()).toMatchObject({ action: 'waiting', gate: expect.stringMatching(/waiting for HEAD to contain bbbbbbb/) });
    expect(world.restarts).toHaveLength(0);
    // HEAD reaches a commit that contains the sha.
    world.head = NEWER;
    expect((await watcher.tick()).action).toBe('restart');
    expect(world.restarts[0].sha).toBe(NEWER);
  });

  it('restarts when HEAD is exactly the sha', async () => {
    const { layer, watcher, world } = build({ head: NEW });
    await post(layer, { reason: 'deploy', sha: NEW });
    expect((await watcher.tick()).action).toBe('restart');
    expect(world.restarts).toHaveLength(1);
  });

  it('refuses a config-only request once HEAD has moved since boot', async () => {
    const { layer } = build({ head: NEW, bootSha: OLD });
    const r = await post(layer, { reason: 'config' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('head moved (config-only)');
    expect(fs.existsSync(path.join(dir, 'state.json')) ? readState().requests : []).toEqual([]);
  });

  it('accepts a config-only request while HEAD is the boot commit, and holds it if HEAD moves', async () => {
    const { layer, watcher, world } = build({ head: OLD, bootSha: OLD });
    expect((await post(layer, { reason: 'config' })).status).toBe(202);
    world.head = NEW;
    const r = await watcher.tick();
    expect(r).toMatchObject({ action: 'waiting', gate: 'head moved (config-only)' });
    expect(world.restarts).toHaveLength(0);
  });

  it('holds on a dirty tree and on a head that is not landed', async () => {
    const dirty = build({ head: NEW });
    await post(dirty.layer, { reason: 'deploy', sha: NEW });
    dirty.world.dirty = true;
    expect((await dirty.watcher.tick()).gate).toBe('dirty tree');
    const landed = build({ head: NEW, landedRef: 'origin/master' });
    await post(landed.layer, { reason: 'deploy', sha: NEW });
    expect((await landed.watcher.tick()).gate).toBe('head not landed');
  });
});

describe('durable pending request', () => {
  it('is in the state file before the request is accepted, in the rollback readers\' shape', async () => {
    const { layer } = build({ head: NEW });
    const r = await post(layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    expect(readState()).toMatchObject({
      id: r.body.id, state: 'pending', boot_sha: OLD,
      requests: [{ reason: 'deploy', sha: NEW, request_key: 'k1' }],
      pending_since: expect.any(Number), first_request_at: expect.any(Number),
    });
  });

  it('refuses the request when the state file cannot be written, and asks nobody', async () => {
    const { layer, watcher } = build({ head: NEW });
    fs.rmSync(dir, { recursive: true, force: true });
    const r = await post(layer, { reason: 'deploy', sha: NEW });
    expect(r.status).toBe(503);
    expect(watcher.requested).toBeNull();
  });

  it('is restored after a crash and restarts once the sha lands', async () => {
    const a = build({ head: OLD });
    await post(a.layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    // The process dies here. A new process boots on the same commit.
    const b = build({ head: OLD });
    expect(b.watcher.requested).toBeNull();
    expect(b.layer.restore()).toBe(1);
    expect(b.watcher.requested.reason).toBe('deploy');
    expect(b.layer.pending()).toBe(true);
    b.world.head = NEW;
    expect((await b.watcher.tick()).action).toBe('restart');
  });

  it('drops a restored request that the new boot already satisfies', async () => {
    const a = build({ head: NEW });
    await post(a.layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    const b = build({ head: NEW, bootSha: NEW });
    expect(b.layer.restore()).toBe(0);
    expect(b.watcher.requested).toBeNull();
    expect(readState()).toMatchObject({ state: 'cancelled', requests: [] });
    // Its key is forgotten with it.
    expect((await post(b.layer, { reason: 'deploy', sha: NEW, request_key: 'k1' })).status).toBe(202);
  });
});

describe('state file for the crash rollback', () => {
  it('records the restart before the exit: restarting, previous and expected sha, restarting_at', async () => {
    const { layer, watcher, world } = build({ head: NEW });
    await post(layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    world.now += 1000;
    expect((await watcher.tick()).action).toBe('restart');
    expect(readState()).toMatchObject({
      state: 'restarting', previous_sha: OLD, expected_sha: NEW, boot_sha: OLD, boot_id: 'boot-1',
      restarting_at: world.now, participants: [], requests: [{ request_key: 'k1' }],
    });
  });

  it('does not restart when the record cannot be written (the restart stays pending)', async () => {
    const { layer, watcher, world } = build({ head: NEW });
    await post(layer, { reason: 'deploy', sha: NEW });
    fs.rmSync(dir, { recursive: true, force: true });
    const r = await watcher.tick();
    expect(r.action).toBe('waiting');
    expect(world.restarts).toHaveLength(0);
    expect(watcher.restarting).toBe(false);
  });

  it('records an update the watcher found by itself, so the rollback covers it too', async () => {
    const { watcher, world } = build({ head: NEW });
    expect((await watcher.tick()).action).toBe('restart');
    expect(readState()).toMatchObject({ state: 'restarting', previous_sha: OLD, expected_sha: NEW, requests: [{ reason: 'code update', sha: NEW }] });
    expect(world.restarts).toHaveLength(1);
  });

  it('marks the restart back at the next boot, once, with a history line', async () => {
    const a = build({ head: NEW });
    await post(a.layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    await a.watcher.tick();
    const restartedAt = readState().restarting_at;
    const b = build({ head: NEW, bootSha: NEW });
    b.world.now = T0 + 5000;
    const state = readState();
    expect(state).toMatchObject({ state: 'back', boot_sha: NEW, expected_sha: NEW, restarting_at: restartedAt, results: { code_mismatch: false } });
    expect(state.booted_at).toEqual(expect.any(Number));
    // A second boot reconciliation of the same restart adds no second line.
    b.layer.reconcileBoot();
    build({ head: NEW, bootSha: NEW });
    const lines = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: state.id, state: 'back', abandoned: false, requests: [{ request_key: 'k1' }], results: { code_mismatch: false } });
  });

  it('reports a code mismatch when the boot is not the expected sha', async () => {
    const a = build({ head: NEW });
    await post(a.layer, { reason: 'deploy', sha: NEW });
    await a.watcher.tick();
    build({ head: OLD, bootSha: OLD });
    expect(readState().results).toEqual({ code_mismatch: true });
  });

  it('refuses a new request and a cancel once the restart is committed', async () => {
    const { layer, watcher } = build({ head: NEW });
    await post(layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    await watcher.tick();
    expect((await post(layer, { reason: 'again', sha: NEW })).status).toBe(503);
    expect(await layer.handle({ method: 'DELETE' })).toMatchObject({ status: 409, body: { error: 'restarting' } });
  });
});

describe('request-only mode (MATRON_CODE_UPDATE_AUTO=0)', () => {
  it('a HEAD move alone restarts nothing, a request restarts', async () => {
    const { layer, watcher, world } = build({ head: NEW, autoUpdate: false });
    for (let i = 0; i < 5; i++) { world.now += 3600_000; expect(await watcher.tick()).toMatchObject({ action: 'none', reason: 'request-only' }); }
    expect(world.restarts).toHaveLength(0);
    await post(layer, { reason: 'deploy', sha: NEW });
    expect((await watcher.tick()).action).toBe('restart');
    expect(world.restarts).toHaveLength(1);
  });

  it('goes back to doing nothing when the request is cancelled', async () => {
    const { layer, watcher, world } = build({ head: NEW, autoUpdate: false, busy: 1 });
    await post(layer, { reason: 'deploy', sha: NEW });
    expect((await watcher.tick()).action).toBe('waiting');
    await layer.handle({ method: 'DELETE' });
    world.busy = 0;
    expect((await watcher.tick()).action).toBe('none');
    expect(world.restarts).toHaveLength(0);
  });
});

describe('never forced, gate hold never lapses', () => {
  it('pins gateMaxMs to Infinity and forceAfterMs to 0', () => {
    expect(PINNED_WATCHER_OPTIONS).toEqual({ gateMaxMs: Infinity, forceAfterMs: 0 });
    expect(Object.isFrozen(PINNED_WATCHER_OPTIONS)).toBe(true);
  });

  it('a gate that holds is still holding after 30 days (upstream\'s default restarts after 8 hours)', async () => {
    const holding = { hold: true, reason: 'operator hold' };
    const { layer, watcher, world } = build({ head: NEW, commandGate: async () => holding });
    await post(layer, { reason: 'deploy', sha: NEW });
    for (const hours of [0, 1, 9, 24 * 30]) {
      world.now = T0 + hours * 3600_000;
      expect(await watcher.tick()).toMatchObject({ action: 'waiting', gate: 'operator hold' });
    }
    expect(world.restarts).toHaveLength(0);
    // Control: with upstream's default cap the same hold lapses and restarts anyway.
    const control = build({ head: NEW, commandGate: async () => holding, watcherOptions: {} });
    await post(control.layer, { reason: 'deploy', sha: NEW });
    await control.watcher.tick();
    control.world.now = T0 + 9 * 3600_000;
    expect((await control.watcher.tick()).action).toBe('restart');
  });

  it('a running turn is never cut off, however long the request waits', async () => {
    const { layer, watcher, world } = build({ head: NEW, busy: 1 });
    await post(layer, { reason: 'deploy', sha: NEW });
    for (const hours of [1, 9, 72]) {
      world.now = T0 + hours * 3600_000;
      expect((await watcher.tick()).action).toBe('waiting');
    }
    expect(world.restarts).toHaveLength(0);
  });
});

describe('only the watcher\'s own gate counts quiet readings', () => {
  function quietWorld() {
    const world = { now: T0, work: false, calls: 0 };
    const reader = createQuietReader(() => ({
      sessions: new Map([['r1', { alive: true, busy: world.work }]]),
      bootAt: 0,
      readProcessTable: () => { world.calls++; return { ok: true, table: [] }; },
      listRunningSubagents: () => [],
    }), { now: () => world.now, minGapMs: 5000 });
    return { world, reader };
  }

  it('peek never counts: any number of status reads leaves the next gate reading the first', () => {
    const { world, reader } = quietWorld();
    for (let i = 0; i < 10; i++) { world.now += 10_000; expect(reader.peek().quiet).toBe(false); }
    world.now += 10_000;
    expect(reader.count().quiet).toBe(false);
    world.now += 10_000;
    expect(reader.count().quiet).toBe(true);
  });

  it('two gate calls inside the minimum gap are one reading', () => {
    const { world, reader } = quietWorld();
    expect(reader.count().quiet).toBe(false);
    world.now += 100;
    expect(reader.count().quiet).toBe(false);
    world.now += 6000;
    expect(reader.count().quiet).toBe(true);
  });

  it('GET /restart and the verdict published to the journal do not move the gate toward go', async () => {
    const { world, reader } = quietWorld();
    const { layer, watcher } = build({ head: NEW, quiet: reader });
    world.now = T0;
    await post(layer, { reason: 'deploy', sha: NEW });
    for (let i = 0; i < 10; i++) {
      world.now += 10_000;
      await layer.handle({ method: 'GET' });
      layer.evaluate();
    }
    // The first gate reading is still only the first.
    const first = await layer.gate();
    expect(first).toMatchObject({ hold: true, reason: expect.stringMatching(/settling/) });
    world.now += 10_000;
    expect(await layer.gate()).toMatchObject({ hold: false });
    expect(watcher.requested).not.toBeNull();
  });

  it('a holder resets the count', async () => {
    const { world, reader } = quietWorld();
    const { layer } = build({ head: NEW, quiet: reader });
    await post(layer, { reason: 'deploy', sha: NEW });
    world.now += 10_000;
    await layer.gate();
    world.work = true;
    world.now += 10_000;
    expect((await layer.gate()).reason).toMatch(/work pending \(busy\)/);
    world.work = false;
    world.now += 10_000;
    expect((await layer.gate()).reason).toMatch(/settling/);
  });
});

describe('verdict published to the journal', () => {
  it('has the waiting_on shape box_status carries, and is read-only', async () => {
    const { layer, world } = build({ head: OLD });
    await post(layer, { reason: 'deploy', sha: NEW });
    world.holders = [{ session: { journalConvoId: 'c1' }, reason: 'turn in progress' }];
    const v = layer.evaluate();
    expect(v.waiting_on).toMatchObject({
      quiet: { holders: [{ convoId: 'c1', why: 'turn in progress' }], probe_error: null },
      code: expect.stringMatching(/waiting for HEAD to contain/), preflight: null, collect: null, unwarned: [],
    });
  });
});

describe('review follow-ups', () => {
  it('a cancel is durable before it is acknowledged: a crash after it restores nothing', async () => {
    const a = build({ head: OLD });
    await post(a.layer, { reason: 'deploy', sha: NEW, request_key: 'k1' });
    expect((await a.layer.handle({ method: 'DELETE' })).body.cancelled).toBe(true);
    const b = build({ head: OLD });
    expect(b.layer.restore()).toBe(0);
    expect(b.watcher.requested).toBeNull();
  });

  it('a cancel that cannot be written is refused and the request stays', async () => {
    const { layer, watcher } = build({ head: OLD });
    await post(layer, { reason: 'deploy', sha: NEW });
    fs.rmSync(dir, { recursive: true, force: true });
    expect((await layer.handle({ method: 'DELETE' })).status).toBe(503);
    expect(watcher.requested).not.toBeNull();
  });

  it('a key stays the same request however long ago, with no store to expire or evict it', async () => {
    const a = build({ head: NEW });
    const first = await post(a.layer, { reason: 'deploy', sha: NEW, request_key: 'k0' });
    a.layer.commitRestart({ sha: NEW });
    const b = build({ head: NEW, bootSha: NEW });
    b.world.now += 400 * 24 * 3600_000;
    // Many later restarts do not push it out.
    for (let i = 1; i <= 40; i++) {
      await post(b.layer, { reason: `r${i}`, sha: NEW, request_key: `k${i}` });
      b.layer.commitRestart({ sha: NEW });
      build({ head: NEW, bootSha: NEW });
    }
    const c = build({ head: NEW, bootSha: NEW });
    const again = await post(c.layer, { reason: 'late', sha: NEW, request_key: 'k0' });
    expect(again).toMatchObject({ status: 200, body: { idempotent: true, id: first.body.id, state: 'back' } });
  }, 30000);

  it('the code holds are checked again right before the restart is recorded', async () => {
    let touched = false;
    const { layer, watcher, world } = build({ head: NEW, commandGate: async () => { if (!touched) { touched = true; world.dirty = true; } return { hold: false }; } });
    await post(layer, { reason: 'deploy', sha: NEW });
    const r = await watcher.tick();
    expect(r.action).toBe('waiting');
    expect(world.restarts).toHaveLength(0);
    expect(readState().state).toBe('pending');
    world.dirty = false;
    expect((await watcher.tick()).action).toBe('restart');
  });

  it('refuses to record a restart without a verified boot sha, and adopts the watcher\'s reading once', async () => {
    const { layer, watcher, world } = build({ head: NEW, bootSha: null });
    await post(layer, { reason: 'deploy', sha: NEW });
    expect((await watcher.tick()).action).toBe('waiting');
    expect(world.restarts).toHaveLength(0);
    layer.adoptBootSha(OLD);
    layer.adoptBootSha(NEW);
    expect((await watcher.tick()).action).toBe('restart');
    expect(readState()).toMatchObject({ previous_sha: OLD, expected_sha: NEW });
  });
});

describe('observed work starts the quiet count again', () => {
  it('a turn seen by a peek between two gate readings means the next quiet reading is the first', () => {
    const world = { now: T0, work: false };
    const reader = createQuietReader(() => ({
      sessions: new Map([['r1', { alive: true, busy: world.work }]]), bootAt: 0,
      readProcessTable: () => ({ ok: true, table: [] }), listRunningSubagents: () => [],
    }), { now: () => world.now, minGapMs: 5000 });
    expect(reader.count().quiet).toBe(false);
    world.work = true; world.now += 10_000;
    expect(reader.peek().holders).toHaveLength(1);
    world.work = false; world.now += 10_000;
    expect(reader.count().quiet).toBe(false);
    world.now += 10_000;
    expect(reader.count().quiet).toBe(true);
  });
});
