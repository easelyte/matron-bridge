import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRestartBoot, restartResumeText, RESTART_RESUME_PREFIX } from '../lib/restart-boot.js';
import { createRestartNotes } from '../lib/restart-notes.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const MAX_AGE = 6 * 3600_000;

function fixture({ state: initial = {}, deliver = async () => true, now = 1_000_000, bootSha = 'new' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-boot-'));
  roots.push(root);
  let clock = now;
  const notes = createRestartNotes({ heldFile: path.join(root, 'held.json'), pendingFile: path.join(root, 'pending.json'), now: () => clock });
  let state = { id: 'r1', state: 'restarting', requests: [], participants: [], verdicts: {}, restarting_at: now - 60_000,
    expected_sha: 'new', ...initial };
  const stateStore = {
    getState: () => state,
    patch: patch => (state = { ...state, ...patch }),
    setState: (next, patch = {}) => (state = { ...state, ...patch, state: next }),
  };
  const timers = [];
  const log = vi.fn();
  const delivered = vi.fn(deliver);
  const boot = createRestartBoot({ stateStore, notesStore: notes, bootSha, maxAgeMs: MAX_AGE, deliver: delivered,
    now: () => clock, schedule: (fn, delay) => timers.push({ fn, delay }), log });
  return { boot, notes, delivered, timers, log, get state() { return state; }, advance: ms => { clock += ms; },
    async fire() { const t = timers.shift(); await t.fn(); await new Promise(r => setImmediate(r)); return t; } };
}

describe('restart resume text', () => {
  it('says what happened and carries the note with its age', () => {
    const text = restartResumeText({ text: 'run the tests', writtenAt: 0 }, { now: () => 5 * 60_000 });
    expect(text).toBe(`${RESTART_RESUME_PREFIX} The bridge restarted as planned and your turn was not cut off. Your resume note (written 5 min before the restart): run the tests`);
    expect(restartResumeText({ text: 'x', writtenAt: 1000 }, { now: () => 2000, codeMismatch: true })).toContain('different code');
  });
});

describe('restart boot', () => {
  it('is back at once when nobody left a note', () => {
    const f = fixture();
    f.boot.reconcile();
    expect(f.state).toMatchObject({ state: 'back', results: { verdicts: {}, code_mismatch: false } });
    f.boot.start();
    expect(f.timers).toEqual([]);
  });

  it('leaves a restart that is not latched alone', () => {
    const f = fixture({ state: { state: 'pending' } });
    f.boot.reconcile();
    f.boot.start();
    expect(f.state.state).toBe('pending');
    expect(f.timers).toEqual([]);
  });

  it('moves held notes to pending, then carries participants on 15 s after boot and 10 s apart', async () => {
    const f = fixture({ state: { participants: ['a', 'b'] } });
    f.notes.hold('r1', 'a', 'note a');
    f.notes.hold('r1', 'b', 'note b');
    f.boot.reconcile();
    expect(f.notes.listHeld('r1')).toEqual([]);
    expect(f.notes.listPending('r1').map(n => n.convoId).sort()).toEqual(['a', 'b']);
    expect(f.state.state).toBe('restarting');
    f.boot.start();
    expect(f.timers.map(t => t.delay)).toEqual([15_000, 25_000]);
    await f.fire();
    expect(f.delivered).toHaveBeenCalledTimes(1);
    expect(f.delivered.mock.calls[0][0]).toMatchObject({ convoId: 'a' });
    expect(f.delivered.mock.calls[0][0].text).toContain('note a');
    expect(f.state.state).toBe('restarting');
    await f.fire();
    expect(f.state).toMatchObject({ state: 'back', results: { verdicts: { a: { outcome: 'resumed' }, b: { outcome: 'resumed' } } } });
    expect(f.notes.listPending()).toEqual([]);
  });

  it('reports a different booted sha without blocking the resume', async () => {
    const f = fixture({ state: { participants: ['a'] }, bootSha: 'old' });
    f.notes.hold('r1', 'a', 'n');
    f.boot.reconcile();
    f.boot.start();
    await f.fire();
    expect(f.state.results.code_mismatch).toBe(true);
    expect(f.delivered.mock.calls[0][0].text).toContain('different code');
  });

  it('marks an entry left delivering by a crash possibly_delivered, and never delivers it again', async () => {
    const f = fixture({ state: { participants: ['a'] } });
    f.notes.hold('r1', 'a', 'n');
    f.notes.putPending({ ...f.notes.hold('r1', 'a', 'n'), status: 'delivering' });
    f.boot.reconcile();
    expect(f.state).toMatchObject({ state: 'back', results: { verdicts: { a: { outcome: 'possibly_delivered' } } } });
    f.boot.start();
    expect(f.delivered).not.toHaveBeenCalled();
  });

  it('marks the entry delivering before the hand-off, so a crash inside it cannot redeliver', async () => {
    let statusDuringHandoff;
    const f = fixture({ state: { participants: ['a'] } });
    f.notes.hold('r1', 'a', 'n');
    f.delivered.mockImplementation(async () => { statusDuringHandoff = f.notes.listPending('r1')[0].status; return true; });
    f.boot.reconcile();
    f.boot.start();
    await f.fire();
    expect(statusDuringHandoff).toBe('delivering');
  });

  it('retries a failed hand-off after a minute, three attempts in all, then records failed', async () => {
    const f = fixture({ state: { participants: ['a'] }, deliver: async () => false });
    f.notes.hold('r1', 'a', 'n');
    f.boot.reconcile();
    f.boot.start();
    await f.fire();
    expect(f.timers.map(t => t.delay)).toEqual([60_000]);
    expect(f.notes.listPending('r1')[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await f.fire();
    expect(f.timers.map(t => t.delay)).toEqual([60_000]);
    await f.fire();
    expect(f.delivered).toHaveBeenCalledTimes(3);
    expect(f.state).toMatchObject({ state: 'back', results: { verdicts: { a: { outcome: 'failed' } } } });
    expect(f.notes.listPending()).toEqual([]);
  });

  it('stops retrying a hand-off that keeps throwing before delivery, records failed and releases the restart', async () => {
    const f = fixture({ state: { participants: ['a'] } });
    f.notes.hold('r1', 'a', 'n');
    f.boot.reconcile();
    f.boot.start();
    const failing = vi.spyOn(f.notes, 'putPending').mockImplementation(() => { throw new Error('ENOSPC'); });
    await f.fire();
    expect(f.timers.map(t => t.delay)).toEqual([60_000]);
    await f.fire();
    expect(f.timers.map(t => t.delay)).toEqual([120_000]);
    await f.fire();
    expect(f.timers).toEqual([]);
    expect(f.delivered).not.toHaveBeenCalled();
    failing.mockRestore();
    expect(f.state).toMatchObject({ state: 'back', results: { verdicts: { a: { outcome: 'failed' } } } });
    expect(f.notes.listPending()).toEqual([]);
    expect(f.log).toHaveBeenCalledWith('Planned restart recovery failed; giving up on a delivery');
  });

  it('releases the restart even when the stores cannot record the failure', async () => {
    const f = fixture({ state: { participants: ['a'] } });
    f.notes.hold('r1', 'a', 'n');
    f.boot.reconcile();
    f.boot.start();
    vi.spyOn(f.notes, 'putPending').mockImplementation(() => { throw new Error('EIO'); });
    vi.spyOn(f.notes, 'removePending').mockImplementation(() => { throw new Error('EIO'); });
    await f.fire(); await f.fire(); await f.fire();
    expect(f.state).toMatchObject({ state: 'back', results: { recovery_failed: true }, verdicts: { a: { outcome: 'failed' } } });
  });

  it('treats a throwing hand-off as a failed attempt', async () => {
    const f = fixture({ state: { participants: ['a'] }, deliver: async () => { throw new Error('boom'); } });
    f.notes.hold('r1', 'a', 'n');
    f.boot.reconcile();
    f.boot.start();
    await f.fire();
    expect(f.notes.listPending('r1')[0].attempts).toBe(1);
  });

  it('keeps a delivery pending and retries when the note store fails mid-handoff', async () => {
    const f = fixture({ state: { participants: ['a'] } });
    f.notes.hold('r1', 'a', 'n');
    f.boot.reconcile();
    f.boot.start();
    const original = f.notes.putPending;
    const failing = vi.spyOn(f.notes, 'putPending').mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    await f.fire();
    expect(failing).toHaveBeenCalled();
    expect(f.delivered).not.toHaveBeenCalled();
    expect(f.timers.map(t => t.delay)).toEqual([60_000]);
    expect(f.log).toHaveBeenCalledWith('Planned restart recovery degraded; delivery remains pending');
    failing.mockRestore();
    expect(original).toBeTypeOf('function');
  });

  it('gives up on a restart older than the carry-on window: every participant stale, notes dropped', () => {
    const f = fixture({ state: { participants: ['a'], restarting_at: 1_000_000 - MAX_AGE - 1 } });
    f.notes.hold('r1', 'a', 'old');
    f.boot.reconcile();
    expect(f.state).toMatchObject({ state: 'back', results: { verdicts: { a: { outcome: 'stale' } } } });
    expect(f.notes.listHeld('r1')).toEqual([]);
    expect(f.notes.listPending()).toEqual([]);
    f.boot.start();
    expect(f.delivered).not.toHaveBeenCalled();
  });

  it('treats a restart with no restart time as too old', () => {
    const f = fixture({ state: { participants: [], restarting_at: null } });
    f.boot.reconcile();
    expect(f.state.state).toBe('back');
  });

  it('rejects a corrupt delivery entry instead of guessing', () => {
    const f = fixture({ state: { participants: ['a'] } });
    f.notes.putPending({ id: 'r1', convoId: 'a', text: 'n', writtenAt: 1, attempts: 99 });
    expect(() => f.boot.reconcile()).toThrow('Invalid restart delivery');
  });

  it('refuses to start before it has reconciled, so notes are never missed', () => {
    const f = fixture({ state: { participants: ['a'] } });
    f.notes.hold('r1', 'a', 'n');
    expect(() => f.boot.start()).toThrow('not reconciled');
    expect(f.timers).toEqual([]);
    f.boot.reconcile();
    f.boot.start();
    expect(f.timers).toHaveLength(1);
  });

  it('records failed for a participant whose note is gone, so the restart is not left waiting', () => {
    const f = fixture({ state: { participants: ['a', 'b'] } });
    f.notes.hold('r1', 'a', 'n');
    f.boot.reconcile();
    expect(f.state.verdicts).toEqual({ b: { outcome: 'failed', at: 1_000_000 } });
    expect(f.state.state).toBe('restarting');
  });

  it('records failed when an entry disappears between boot and its hand-off', async () => {
    const f = fixture({ state: { participants: ['a'] } });
    f.notes.hold('r1', 'a', 'n');
    f.boot.reconcile();
    f.boot.start();
    f.notes.removePending('r1', 'a');
    await f.fire();
    expect(f.state).toMatchObject({ state: 'back', results: { verdicts: { a: { outcome: 'failed' } } } });
  });

  it('starts at most once', () => {
    const f = fixture({ state: { participants: ['a'] } });
    f.notes.hold('r1', 'a', 'n');
    f.boot.reconcile();
    f.boot.start();
    f.boot.start();
    expect(f.timers).toHaveLength(1);
  });
});
