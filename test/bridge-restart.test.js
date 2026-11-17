import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { bridgeRestartResponse } from '../lib/bridge-restart.js';
import { createCodeUpdateWatcher, DEFAULT_WARN_EVERY_MS } from '../lib/code-update-restart.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const T0 = Date.parse('2026-10-02T16:00:00Z');
const holders = [{ session: { roomId: '!r1' }, reason: 'turn in progress' }];

function harness({ head, busy = 0, preflightOk = true } = {}) {
  const state = { head, busy, now: T0, log: [], warn: [], restarts: [], preflights: 0 };
  const watcher = createCodeUpdateWatcher({
    readHead: () => state.head,
    busySessions: () => state.busy,
    preflight: async () => { state.preflights++; return preflightOk ? { ok: true } : { ok: false, error: 'sharp missing' }; },
    restart: (info) => state.restarts.push(info),
    now: () => state.now,
    log: (m) => state.log.push(m),
    warn: (m) => state.warn.push(m),
    bootSha: OLD,
  });
  return { state, watcher };
}

describe('requested bridge restart (watcher)', () => {
  const onBoot = { sha: OLD, at: T0 - 60 * 60_000 };

  it('survives HEAD being on the boot commit, which drops a plain pending update', async () => {
    const { state, watcher } = harness({ head: onBoot });
    expect((await watcher.tick()).action).toBe('none');
    expect(watcher.request({ reason: 'new env', by: 'deploy' }).ok).toBe(true);
    expect(watcher.requested).toMatchObject({ reason: 'new env', by: 'deploy' });
    const r = await watcher.tick();
    expect(r.action).toBe('restart');
    expect(r.requested.reason).toBe('new env');
    expect(state.restarts).toHaveLength(1);
    expect(state.restarts[0].sha).toBe(OLD);
    expect(state.preflights).toBe(1);
    expect(state.log.join('\n')).toMatch(/bridge restart/);
  });

  it('does not wait for the settle window', async () => {
    const { state, watcher } = harness({ head: { sha: NEW, at: T0 - 1000 } });
    watcher.request({ reason: 'x' });
    expect((await watcher.tick()).action).toBe('restart');
    expect(state.restarts).toHaveLength(1);
  });

  it('waits for holders, warns every 30 minutes, then restarts', async () => {
    const { state, watcher } = harness({ head: onBoot, busy: 1 });
    watcher.request({ reason: 'new env' });
    expect((await watcher.tick()).action).toBe('waiting');
    state.now += DEFAULT_WARN_EVERY_MS + 1000;
    await watcher.tick();
    expect(state.warn.join('\n')).toMatch(/still waiting to restart onto \w+ \(bridge restart requested: new env\)/);
    expect(state.restarts).toHaveLength(0);
    state.busy = 0;
    expect((await watcher.tick()).action).toBe('restart');
  });

  // A preflight the test resolves by hand, to land a POST or DELETE mid-check.
  function gated(head, outcomes) {
    const state = { head, busy: 0, now: T0, log: [], warn: [], restarts: [], preflights: 0, release: [] };
    const watcher = createCodeUpdateWatcher({
      readHead: () => state.head,
      busySessions: () => state.busy,
      preflight: () => new Promise((resolve) => { const ok = outcomes[state.preflights++]; state.release.push(() => resolve(ok ? { ok: true } : { ok: false, error: 'broken tree' })); }),
      restart: (info) => state.restarts.push(info),
      now: () => state.now,
      log: (m) => state.log.push(m),
      warn: (m) => state.warn.push(m),
      bootSha: OLD,
    });
    return { state, watcher };
  }

  it('a cancel during the preflight stops the restart it was checking for', async () => {
    const { state, watcher } = gated(onBoot, [true]);
    watcher.request({ reason: 'x' });
    const t = watcher.tick();
    await Promise.resolve();
    expect(watcher.cancelRequest()).toBe(true);
    state.release[0]();
    expect((await t).action).toBe('superseded');
    expect((await watcher.tick()).action).toBe('none');
    expect(state.restarts).toHaveLength(0);
  });

  it('a repeat request during a failing preflight gets a fresh check', async () => {
    const { state, watcher } = gated(onBoot, [false, true]);
    watcher.request({ reason: 'first' });
    const t = watcher.tick();
    await Promise.resolve();
    watcher.request({ reason: 'tree repaired' });
    state.release[0]();
    expect((await t).action).toBe('superseded');
    expect(watcher.requested.error).toBeNull();
    const t2 = watcher.tick();
    await Promise.resolve();
    state.release[1]();
    expect((await t2).action).toBe('restart');
    expect(state.preflights).toBe(2);
  });

  function withGate(head, gate) {
    const state = { head, busy: 0, now: T0, log: [], warn: [], restarts: [] };
    const watcher = createCodeUpdateWatcher({
      readHead: () => state.head,
      busySessions: () => state.busy,
      preflight: async () => ({ ok: true }),
      restart: (info) => state.restarts.push(info),
      gate,
      now: () => state.now,
      log: (m) => state.log.push(m),
      warn: (m) => state.warn.push(m),
      bootSha: OLD,
    });
    return { state, watcher };
  }

  it('reports the gate verdict that holds a requested restart, and clears it when the gate says go', async () => {
    let verdict = { hold: true, reason: 'deploy in progress' };
    const { state, watcher } = withGate(onBoot, async () => verdict);
    expect(watcher.gateHoldReason).toBeNull();
    watcher.request({ reason: 'x' });
    expect((await watcher.tick()).action).toBe('waiting');
    expect(watcher.gateHoldReason).toBe('deploy in progress');
    verdict = { hold: false };
    expect((await watcher.tick()).action).toBe('restart');
    expect(watcher.gateHoldReason).toBeNull();
    expect(state.restarts).toHaveLength(1);
  });

  it('a cancel while the gate is being asked stops the requested restart', async () => {
    let release;
    const { state, watcher } = withGate(onBoot, () => new Promise((resolve) => { release = () => resolve({ hold: false }); }));
    watcher.request({ reason: 'x' });
    const t = watcher.tick();
    for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
    expect(watcher.cancelRequest()).toBe(true);
    release();
    expect((await t).action).toBe('none');
    expect(state.restarts).toHaveLength(0);
  });

  it('drops a preflight result when HEAD moved during the check', async () => {
    const { state, watcher } = gated(onBoot, [true, true]);
    watcher.request({ reason: 'x' });
    const t = watcher.tick();
    await Promise.resolve();
    state.head = { sha: NEW, at: T0 - 60 * 60_000 };
    state.release[0]();
    expect((await t).action).toBe('superseded');
    expect(state.restarts).toHaveLength(0);
    const t2 = watcher.tick();
    await Promise.resolve();
    state.release[1]();
    expect(await t2).toMatchObject({ action: 'restart', sha: NEW });
    expect(state.preflights).toBe(2);
  });

  it('a new request after a cancel runs the preflight again on the same HEAD', async () => {
    const { state, watcher } = harness({ head: onBoot, busy: 1 });
    watcher.request({ reason: 'first' });
    expect((await watcher.tick()).action).toBe('waiting');
    expect(state.preflights).toBe(1);
    watcher.cancelRequest();
    watcher.request({ reason: 'again' });
    state.busy = 0;
    expect((await watcher.tick()).action).toBe('restart');
    expect(state.preflights).toBe(2);
  });

  it('a tick during a held gate call after a cancel does not break the gated tick', async () => {
    let release;
    const { state, watcher } = withGate(onBoot, () => new Promise((resolve) => { release = () => resolve({ hold: true, reason: 'busy' }); }));
    watcher.request({ reason: 'x' });
    const t = watcher.tick();
    for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
    watcher.cancelRequest();
    expect((await watcher.tick()).action).toBe('none');
    release();
    expect((await t).action).toBe('none');
    expect(watcher.gateHoldReason).toBeNull();
    expect(state.restarts).toHaveLength(0);
  });

  it('an update whose HEAD goes back to boot during a held gate call ends cleanly', async () => {
    let release;
    const { state, watcher } = withGate({ sha: NEW, at: T0 - 60 * 60_000 }, () => new Promise((resolve) => { release = () => resolve({ hold: true, reason: 'busy' }); }));
    const t = watcher.tick();
    for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
    state.head = onBoot;
    expect((await watcher.tick()).action).toBe('none');
    release();
    await expect(t).resolves.toMatchObject({ action: 'waiting' });
    expect((await watcher.tick()).action).toBe('none');
    expect(watcher.gateHoldReason).toBeNull();
    expect(state.restarts).toHaveLength(0);
  });

  it('keeps a failed preflight pending and reports it', async () => {
    const { state, watcher } = harness({ head: onBoot, preflightOk: false });
    watcher.request({ reason: 'x' });
    const r = await watcher.tick();
    expect(r).toMatchObject({ action: 'refused', error: 'sharp missing' });
    expect(watcher.requested).toMatchObject({ error: 'sharp missing' });
    expect(state.warn.join('\n')).toMatch(/stays pending/);
    await watcher.tick();
    expect(state.preflights).toBe(1);
    expect(state.restarts).toHaveLength(0);
    watcher.request({ reason: 'again' });
    await watcher.tick();
    expect(state.preflights).toBe(2);
  });

  it('cancel clears it, and HEAD on boot then does nothing', async () => {
    const { state, watcher } = harness({ head: onBoot, busy: 1 });
    watcher.request({ reason: 'x' });
    await watcher.tick();
    expect(watcher.cancelRequest()).toBe(true);
    expect(watcher.requested).toBeNull();
    expect(watcher.cancelRequest()).toBe(false);
    state.busy = 0;
    expect((await watcher.tick()).action).toBe('none');
    expect(state.restarts).toHaveLength(0);
  });

  it('refuses a request once the bridge is exiting', async () => {
    const { watcher } = harness({ head: onBoot });
    watcher.request({ reason: 'x' });
    await watcher.tick();
    expect(watcher.request({ reason: 'y' }).ok).toBe(false);
  });
});

describe('bridgeRestartResponse', () => {
  it('answers 409 with the reason on every method when the watcher is not running', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const r = await bridgeRestartResponse({ method, watcher: null, holds: () => ({ holders: [], unreadable: false }) });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/watcher is not running/);
    }
  });

  it('dry run lists who holds the restart and why, and changes nothing', async () => {
    const { watcher } = harness({ head: { sha: OLD, at: 0 }, busy: 1 });
    const r = await bridgeRestartResponse({ method: 'GET', watcher, holds: () => ({ holders, unreadable: false }), gateHold: async () => 'deploy window' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ requested: null, holders: [{ roomId: '!r1', reason: 'turn in progress' }], unreadable: false, gate: 'deploy window' });
    expect(watcher.requested).toBeNull();
  });

  it('POST requests with the reason, DELETE cancels', async () => {
    const { watcher } = harness({ head: { sha: OLD, at: 0 }, busy: 1 });
    const holds = () => ({ holders, unreadable: false });
    const post = await bridgeRestartResponse({ method: 'POST', body: { reason: 'new env' }, watcher, holds });
    expect(post.status).toBe(202);
    expect(post.body.requested).toMatchObject({ reason: 'new env', by: 'operator' });
    expect(post.body.holders).toHaveLength(1);
    const del = await bridgeRestartResponse({ method: 'DELETE', watcher, holds });
    expect(del).toEqual({ status: 200, body: { cancelled: true } });
    expect(watcher.requested).toBeNull();
    expect((await bridgeRestartResponse({ method: 'DELETE', watcher, holds })).body.cancelled).toBe(false);
  });
});

describe('/restart route wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const at = index.indexOf("if (url.pathname === '/restart') {");
  const route = index.slice(at, index.indexOf("if (req.method !== 'POST') {", at));

  it('needs the operator caller even when MATRON_BRIDGE_API_AUTH=off', () => {
    // The fork also lets the per-boot restart token in; nothing else gets past this.
    expect(route).toMatch(/if \(!restartTokenOk && apiCaller\?\.kind !== 'operator'\) \{[\s\S]*?res\.writeHead\(403/);
    expect(route.indexOf("apiCaller?.kind !== 'operator'")).toBeLessThan(route.indexOf('restartRequests.handle('));
  });
});
