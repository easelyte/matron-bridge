import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlannedRestartState } from '../lib/planned-restart-state.js';
import { createRestartNotes } from '../lib/restart-notes.js';
import { createRestartBoot, createRestartCancellation } from '../lib/restart-boot.js';

const roots = [];
const clearTimers = () => { const at = Date.now(); vi.clearAllTimers(); vi.setSystemTime(at); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000000); });
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture({ participants = ['alice', 'bob'], noted = participants, age = 100, maxAgeMs = 1000000, patch = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-boot-'));
  roots.push(root);
  const stateOptions = { file: path.join(root, 'state.json'), historyFile: path.join(root, 'history.jsonl'), makeId: () => 'restart-a' };
  const notesOptions = { heldFile: path.join(root, 'held.json'), pendingFile: path.join(root, 'pending.json') };
  const state = createPlannedRestartState(stateOptions);
  const notes = createRestartNotes(notesOptions);
  state.addRequest({ request_key: 'request-a' });
  state.setState(patch.state || 'restarting', { participants, restarting_at: Date.now() - age,
    expected_sha: 'code-a', stamp_written: true, notified: { alice: {}, bob: {}, idle: {} }, ...patch });
  for (const convoId of noted) notes.hold('restart-a', convoId, `Continue ${convoId}`);
  const calls = [];
  const errors = [];
  const schedule = (fn, ms) => setTimeout(() => {
    try {
      Promise.resolve(fn()).catch(error => { errors.push(error); clearTimers(); });
    } catch (error) { errors.push(error); clearTimers(); }
  }, ms);
  const boot = (options = {}) => createRestartBoot({
    stateStore: createPlannedRestartState(stateOptions), notesStore: createRestartNotes(notesOptions),
    markerStore: { list: () => Object.fromEntries(participants.map(id => [id, { bootId: 'previous' }])) },
    bootId: 'current', bootSha: 'code-a', maxAgeMs,
    takeStamp: () => null, schedule,
    deliver: async entry => { calls.push(entry); return true; }, ...options,
  });
  const history = () => fs.existsSync(stateOptions.historyFile)
    ? fs.readFileSync(stateOptions.historyFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { state, notes, stateOptions, notesOptions, boot, calls, errors, schedule, history };
}
function start(f, options = {}) {
  const boot = f.boot(options);
  boot.reconcile();
  expect(f.state.getState().stamp_written, 'boot clears the durable stamp flag').toBe(false);
  boot.listenerReady();
  return boot;
}
const drain = async f => { await vi.runAllTimersAsync(); if (f.errors.length) throw f.errors.shift(); };

it('delivers held notes without a stamp', async () => {
  const f = fixture();
  const boot = f.boot();
  boot.reconcile();
  boot.listenerReady();
  await drain(f);
  expect(f.calls.length, 'expected 2 notes delivered with no stamp, got 0').toBe(2);
  expect(f.state.getState().state).toBe('back');
  expect(f.notes.listPending('restart-a')).toEqual([]);
});

it('moves notes before scheduling and persists reconciliation before taking the stamp', async () => {
  const f = fixture();
  let armed = 0;
  start(f, { takeStamp: () => {
    expect(f.state.getState().boot_phase).toEqual({ bootId: 'current', phase: 'reconciling' });
    return { sha: 'code-a' };
  }, schedule: (fn, ms) => {
    expect(f.notes.listHeld('restart-a')).toEqual([]);
    if (armed++ < 2) expect(f.notes.listPending('restart-a')).toHaveLength(2);
    return f.schedule(fn, ms);
  } });
  await drain(f);
});

const crashes = ['reconciling', 'stamp_taken', 'pending_written', 'held_rewritten', 'marker_entry',
  'notes_moved', 'booted', 'delivering', 'handed_off', 'verdict', 'back'];
it.each(crashes)('recovers from a crash at %s using persisted files', async point => {
  const f = fixture({ participants: ['alice', 'bob', 'charlie'], noted: ['alice'] });
  let crashed = false;
  const onStep = step => {
    if (!crashed && step === point) { crashed = true; throw new Error('simulated crash'); }
  };
  const crashFs = { ...fs, renameSync: (from, to) => {
    fs.renameSync(from, to);
    if (to === f.notesOptions.pendingFile && point === 'pending_written') {
      expect(f.notes.listHeld('restart-a').map(entry => entry.convoId), 'source remains until destination commits').toEqual(['alice']);
      onStep('pending_written');
    }
  } };
  try {
    const boot = f.boot({ onStep, notesStore: createRestartNotes({ ...f.notesOptions, fs: crashFs }) });
    boot.reconcile();
    boot.listenerReady();
    await drain(f);
  } catch (error) { expect(error.message).toBe('simulated crash'); }
  expect(crashed, 'crash seam must execute').toBe(true);
  clearTimers();
  start(f);
  await drain(f);
  const state = f.state.getState();
  expect(Object.keys(state.verdicts).sort()).toEqual(['alice', 'bob', 'charlie']);
  expect(state.state).toBe('back');
  expect(f.notes.listHeld('restart-a')).toEqual([]);
  expect(f.notes.listPending('restart-a')).toEqual([]);
  expect(new Set(f.calls.map(entry => entry.convoId)).size).toBe(f.calls.length);
  expect(f.history()).toHaveLength(1);
});

it.each([1000, 1001])('abandons only beyond the maximum age: %i', async age => {
  const f = fixture({ age, maxAgeMs: 1000, patch: { verdicts: { alice: { outcome: 'resumed', at: 10 } } } });
  start(f);
  await drain(f);
  const state = f.state.getState();
  expect(state.verdicts.alice).toEqual({ outcome: 'resumed', at: 10 });
  expect(state.state).toBe(age === 1000 ? 'back' : 'abandoned');
  expect(state.verdicts.bob.outcome).toBe('stale');
  expect(f.calls.map(entry => entry.convoId)).toEqual([]);
  expect(f.notes.listHeld('restart-a')).toEqual([]);
  expect(f.notes.listPending('restart-a')).toEqual([]);
  expect(f.history()[0].abandoned).toBe(age === 1001);
});

it('expires live delivery after 500 deferrals and accepts a new restart request', async () => {
  const maxAgeMs = 15000 + 500 * 60000;
  const f = fixture({ age: 0, maxAgeMs, patch: { verdicts: { bob: { outcome: 'resumed', at: 7 } } } });
  const deliver = vi.fn(async () => ({ deferred: true }));
  start(f, { deliver });
  await vi.advanceTimersByTimeAsync(maxAgeMs - 1);
  expect(deliver).toHaveBeenCalledTimes(500);
  expect(f.state.getState().state).toBe('restarting');
  expect(f.notes.listPending('restart-a')[0]).toMatchObject({ attempts: 0, status: 'pending' });
  await vi.advanceTimersByTimeAsync(1);
  expect(f.state.getState()).toMatchObject({ state: 'back', results: { verdicts: {
    alice: { outcome: 'stale' }, bob: { outcome: 'resumed', at: 7 },
  } } });
  expect(deliver).toHaveBeenCalledTimes(500);
  expect(f.notes.listPending('restart-a')).toEqual([]);
  expect(f.history()).toHaveLength(1);
  expect(f.history()[0].abandoned).toBe(false);
  await drain(f);
  expect(f.history()).toHaveLength(1);
  const next = createPlannedRestartState({ ...f.stateOptions, makeId: () => 'restart-b' });
  expect(next.addRequest({ request_key: 'bob' })).toEqual({ id: 'restart-b', state: 'pending' });
}, 60000);

it.each([19999, 20000])('checks the live deadline before rescheduling at age %i', async age => {
  const f = fixture({ participants: ['alice'], age: 0, maxAgeMs: 20000 });
  const at = Date.now();
  const deliver = vi.fn(async () => {
    vi.setSystemTime(at + age);
    return { deferred: true };
  });
  start(f, { deliver });
  await vi.advanceTimersByTimeAsync(15000);
  expect(deliver).toHaveBeenCalledOnce();
  if (age === 19999) {
    expect(f.state.getState().state).toBe('restarting');
    expect(f.state.getState().verdicts).toEqual({});
    expect(f.notes.listPending('restart-a')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60000);
  }
  expect(f.state.getState().state).toBe('back');
  expect(f.state.getState().verdicts.alice.outcome).toBe('stale');
  expect(f.notes.listPending('restart-a')).toEqual([]);
  expect(f.history()).toHaveLength(1);
  expect(f.history()[0].abandoned).toBe(false);
});

it('creates marker-only entries once and never resumes notified-only conversations', async () => {
  const f = fixture({ noted: [] });
  start(f);
  await drain(f);
  expect(f.calls.map(entry => entry.convoId)).toEqual(['alice', 'bob']);
  expect(f.calls.every(entry => entry.text === 'The bridge restarted. Carry on from where you left off.')).toBe(true);
  expect(f.state.getState().results.no_note).toEqual(['idle']);
  expect(f.state.getState().state).toBe('back');
});

it('reports rollback code mismatch and retains booted_at on subsequent boots', async () => {
  const f = fixture();
  start(f, { bootSha: 'code-b' });
  await drain(f);
  expect(f.state.getState().results.code_mismatch).toBe(true);
  const at = f.state.getState().booted_at;
  vi.setSystemTime(Date.now() + 100);
  start(f);
  expect(f.state.getState().booted_at).toBe(at);
  expect(f.history()).toHaveLength(1);
});

it.each(['back', 'abandoned'])('repairs history after a durable %s without changing booted_at', state => {
  const f = fixture({ noted: [], patch: { state, booted_at: 7, results: { verdicts: {} } } });
  start(f);
  start(f);
  expect(f.history()).toHaveLength(1);
  expect(f.state.getState().booted_at).toBe(7);
});

it.each([10, 11])('stagger boundary for %i participants', async count => {
  const participants = Array.from({ length: count }, (_, i) => `alice-${i}`);
  const f = fixture({ participants });
  start(f);
  await vi.advanceTimersByTimeAsync(14999);
  expect(f.calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.calls).toHaveLength(count === 10 ? 1 : 2);
  await vi.advanceTimersByTimeAsync(9999);
  expect(f.calls).toHaveLength(count === 10 ? 1 : 2);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.calls).toHaveLength(count === 10 ? 2 : 4);
  await drain(f);
  expect(f.state.getState().state).toBe('back');
});

it.each(['refused', 'exception'])('retries %s handoffs a minute apart and fails on attempt three', async failure => {
  const f = fixture({ participants: ['alice'] });
  const deliver = vi.fn(async () => { if (failure === 'exception') throw new Error('unavailable'); return false; });
  start(f, { deliver });
  await vi.advanceTimersByTimeAsync(15000);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(f.notes.listPending('restart-a')[0]).toMatchObject({ attempts: 1, status: 'pending' });
  await vi.advanceTimersByTimeAsync(59999);
  expect(deliver).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(f.state.getState().verdicts).toEqual({});
  await vi.advanceTimersByTimeAsync(60000);
  expect(deliver).toHaveBeenCalledTimes(3);
  expect(f.state.getState().verdicts.alice).toMatchObject({ outcome: 'failed' });
  expect(f.notes.listPending('restart-a')).toEqual([]);
});

it('records possibly_delivered for a persisted delivering entry without handing it off again', async () => {
  const f = fixture();
  f.notes.moveToPending('restart-a');
  const entries = JSON.parse(fs.readFileSync(f.notesOptions.pendingFile, 'utf8'));
  entries[0].status = 'delivering';
  fs.writeFileSync(f.notesOptions.pendingFile, JSON.stringify(entries));
  start(f);
  await drain(f);
  expect(f.state.getState().verdicts.alice.outcome).toBe('possibly_delivered');
  expect(f.calls.map(entry => entry.convoId)).toEqual(['bob']);
});

it('persists a verdict before removing the pending entry', async () => {
  const f = fixture();
  start(f, { onStep: step => {
    if (step === 'verdict') {
      expect(f.notes.listPending('restart-a').length).toBeGreaterThan(0);
      expect(Object.keys(f.state.getState().verdicts).length).toBeGreaterThan(0);
    }
  } });
  await drain(f);
});

it.each(['state', 'held', 'pending', 'markers', 'stamp', 'scheduler', 'save', 'move', 'booted'])('refuses %s errors without falsely reporting delivery', async source => {
  const f = fixture();
  const error = () => { throw new Error('unreadable'); };
  const deps = {
    state: { stateStore: { ...f.state, getState: error } },
    held: { notesStore: { ...f.notes, listHeld: error } },
    pending: { notesStore: { ...f.notes, listPending: error } },
    markers: { markerStore: { list: error } },
    stamp: { takeStamp: error }, scheduler: { schedule: error },
    save: { stateStore: { ...f.state, patch: error } },
    history: { history: { appendHistoryOnce: error } },
    move: { notesStore: { ...f.notes, moveToPending: error } },
    pending_write: { notesStore: { ...f.notes, putPending: error } },
    pending_remove: { notesStore: { ...f.notes, removePending: error } },
    verdict: { stateStore: { ...f.state, patch: patch => {
      if (patch.verdicts) error();
      return f.state.patch(patch);
    } } },
    booted: { stateStore: { ...f.state, setBootPhase: phase => {
      if (phase === 'booted') error();
      return f.state.setBootPhase(phase);
    } } },
  }[source];
  let failed = false;
  try { const boot = f.boot(deps); boot.reconcile(); boot.listenerReady(); await drain(f); }
  catch (e) { failed = e.message === 'unreadable'; }
  expect(failed, 'dependency failure must surface').toBe(true);
  if (!['history', 'pending_remove', 'verdict'].includes(source)) expect(f.calls).toEqual([]);
  if (source === 'history') expect(f.state.getState().history_appended).toBe(false);
  if (source === 'verdict') expect(f.state.getState().verdicts).toEqual({});
});

it.each(['history', 'pending_write', 'pending_remove', 'verdict'])('logs %s timer failures and retains durable delivery evidence', async source => {
  const f = fixture();
  const error = () => { throw new Error('unreadable'); };
  const deps = {
    history: { history: { appendHistoryOnce: error } },
    pending_write: { notesStore: { ...f.notes, putPending: error } },
    pending_remove: { notesStore: { ...f.notes, removePending: error } },
    verdict: { stateStore: { ...f.state, patch: patch => { if (patch.verdicts) error(); return f.state.patch(patch); } } },
  }[source];
  const log = vi.fn();
  const boot = f.boot({ ...deps, schedule: undefined, log });
  boot.reconcile(); boot.listenerReady();
  await vi.advanceTimersByTimeAsync(25000);
  expect(log).toHaveBeenCalledWith('Planned restart recovery degraded; delivery remains pending');
  if (source === 'pending_write') { expect(f.calls).toEqual([]); expect(f.notes.listPending()).toHaveLength(2); }
  if (source === 'pending_remove') expect(f.notes.listPending()).toHaveLength(2);
  if (source === 'history') expect(f.state.getState().history_appended).toBe(false);
  if (source === 'verdict') { expect(f.state.getState().verdicts).toEqual({}); expect(f.notes.listPending().every(note => note.status === 'delivering')).toBe(true); }
});

it('handles missing note files by creating marker-only pending records', async () => {
  const f = fixture({ noted: [] });
  start(f);
  await drain(f);
  expect(f.state.getState().verdicts.alice.outcome).toBe('resumed');
});

it('processes pending entries from other restart ids with durable verdicts', async () => {
  const f = fixture();
  f.notes.hold('restart-b', 'charlie', 'Continue');
  f.notes.moveToPending('restart-b');
  start(f);
  await drain(f);
  expect(f.calls.map(entry => entry.convoId).sort()).toEqual(['alice', 'bob', 'charlie']);
  expect(f.notes.listPending('restart-b')).toEqual([]);
  expect(f.state.getState().other_verdicts['restart-b'].charlie.outcome).toBe('resumed');
});

it('leaves the original boot time unchanged during repeated restarting boots', async () => {
  const f = fixture({ patch: { booted_at: 7 } });
  start(f);
  expect(f.state.getState().booted_at).toBe(7);
  await drain(f);
});

it('initializes absent state without inventing a restart or a delivery', async () => {
  const f = fixture({ noted: [] });
  fs.unlinkSync(f.stateOptions.file);
  start(f);
  await drain(f);
  expect(f.state.getState().boot_phase).toEqual({ bootId: 'current', phase: 'reconciling' });
  expect(f.state.getState().id).toBe(null);
  expect(f.calls).toEqual([]);
  expect(f.history()).toEqual([]);
});

it.each([
  { status: 'unknown' }, { attempts: -1 }, { attempts: 4 }, { attempts: 1.5 }, { retry_at: 'later' },
])('refuses invalid persisted delivery fields %j', invalid => {
  const f = fixture();
  f.notes.moveToPending('restart-a');
  const entries = f.notes.listPending('restart-a');
  fs.writeFileSync(f.notesOptions.pendingFile, JSON.stringify([{ ...entries[0], ...invalid }, entries[1]]));
  expect(() => f.boot().reconcile()).toThrow('Invalid restart delivery');
  expect(f.calls).toEqual([]);
});

it('keeps an older restart verdict when a new request replaces its current state', async () => {
  const f = fixture({ participants: ['alice'], noted: [] });
  f.state.recordVerdict('alice', 'resumed');
  f.state.setState('back');
  f.notes.hold('restart-a', 'alice', 'Already handed off');
  f.notes.moveToPending('restart-a');
  const next = createPlannedRestartState({ ...f.stateOptions, makeId: () => 'restart-b' });
  next.addRequest({ request_key: 'request-b' });
  start(f);
  await drain(f);
  expect(f.notes.listPending('restart-a')).toEqual([]);
  expect(f.calls).toEqual([]);
});

it.each([2, 3])('honors a persisted attempt count of %i', async attempts => {
  const f = fixture({ participants: ['alice'] });
  f.notes.moveToPending('restart-a');
  fs.writeFileSync(f.notesOptions.pendingFile, JSON.stringify(f.notes.listPending('restart-a').map(entry => ({ ...entry, attempts }))));
  const deliver = vi.fn(async () => false);
  start(f, { deliver });
  await drain(f);
  expect(deliver).toHaveBeenCalledTimes(attempts === 2 ? 1 : 0);
  expect(f.state.getState().verdicts.alice).toMatchObject({ outcome: 'failed' });
});

it('uses the participant count for batching even when one verdict already exists', async () => {
  const participants = Array.from({ length: 11 }, (_, i) => `alice-${i}`);
  const f = fixture({ participants, patch: { verdicts: { 'alice-0': { outcome: 'resumed', at: 7 } } } });
  start(f);
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.calls).toHaveLength(2);
  await drain(f);
});

it('preserves the verdict and history invariants across generated crash and participant combinations', async () => {
  for (let seed = 0; seed < 33; seed++) {
    const participants = Array.from({ length: 1 + seed % 5 }, (_, i) => `alice-${i}`);
    const f = fixture({ participants, noted: seed % 2 ? participants : [] });
    const point = crashes[seed % crashes.length];
    let crashed = false;
    try {
      const boot = f.boot({ onStep: step => {
        if (!crashed && step === point) { crashed = true; throw new Error('simulated crash'); }
      }, notesStore: createRestartNotes({ ...f.notesOptions, fs: { ...fs, renameSync: (from, to) => {
        fs.renameSync(from, to);
        if (!crashed && point === 'pending_written' && to === f.notesOptions.pendingFile) {
          crashed = true; throw new Error('simulated crash');
        }
      } } }) });
      boot.reconcile(); boot.listenerReady(); await drain(f);
    } catch (e) { expect(e.message).toBe('simulated crash'); }
    clearTimers();
    start(f); await drain(f); start(f); await drain(f);
    expect(Object.keys(f.state.getState().verdicts).sort()).toEqual(participants.sort());
    expect(f.history()).toHaveLength(1);
    expect(f.calls.length).toBe(new Set(f.calls.map(entry => entry.convoId)).size);
  }
}, 20000);

it.each(['restarting_at', 'expected_sha', 'participants'])('recovers an incomplete restart missing %s on repeated boots', field => {
  const f = fixture();
  const before = f.state.getState();
  delete before[field];
  fs.writeFileSync(f.stateOptions.file, JSON.stringify(before));
  const log = vi.fn();
  for (let i = 0; i < 2; i++) expect(() => f.boot({ log }).reconcile()).not.toThrow();
  expect(f.state.getState()).toMatchObject({ state: 'pending', requests: before.requests, notified: before.notified });
  expect(f.notes.listHeld('restart-a')).toHaveLength(2);
  expect(f.notes.listPending()).toEqual([]);
  expect(log).toHaveBeenCalledOnce();
});

it.each(['final write', 'second notice', 'note removal', 'progress write'])('resumes cancellation after a failed %s with one notice per key', async fault => {
  const f = fixture({ patch: { state: 'pending' } });
  const notices = new Map();
  let fail = true;
  const save = f.state.setState;
  const patch = f.state.patch;
  const remove = f.notes.removeHeld;
  f.state.setState = (state, data) => {
    if (fault === 'final write' && state === 'cancelled' && fail) { fail = false; throw new Error('write refused'); }
    return save(state, data);
  };
  f.state.patch = data => {
    if (fault === 'progress write' && data.cancel_done && fail) { fail = false; throw new Error('write refused'); }
    return patch(data);
  };
  f.notes.removeHeld = (...args) => {
    if (fault === 'note removal' && fail) { fail = false; throw new Error('write refused'); }
    return remove(...args);
  };
  const cancel = createRestartCancellation({ stateStore: f.state, notesStore: f.notes,
    publishText: (convoId, payload, options) => {
      expect(f.state.getState().state, 'cancellation intent precedes notice').toBe('cancelling');
      expect(options.idemKey, 'stable cancellation key').toBe(`restart-cancel:restart-a:${convoId}`);
      if (!notices.has(options.idemKey)) {
        expect(f.notes.listHeld('restart-a').some(note => note.convoId === convoId), 'notice precedes note deletion').toBe(true);
        notices.set(options.idemKey, payload);
      }
      if (fault === 'second notice' && convoId === 'bob' && fail) { fail = false; throw new Error('notice refused'); }
      options.onLocalSendComplete(); return true;
    } });
  await expect(cancel()).rejects.toThrow(/refused/);
  expect(f.state.getState().state).toBe('cancelling');
  expect(f.state.addRequest({ request_key: 'bob' }).busy).toBe('restarting');
  await cancel();
  expect(f.state.getState()).toMatchObject({ state: 'cancelled', requests: [], cancel_done: ['alice', 'bob'] });
  expect(f.notes.listHeld('restart-a')).toEqual([]);
  expect(notices.size).toBe(2);
});

it.each(['delivered', 'evicted'])('retains held notes until a cancellation notice is %s', async outcome => {
  const f = fixture({ patch: { state: 'pending' } });
  let callbacks;
  const cancel = createRestartCancellation({ stateStore: f.state, notesStore: f.notes,
    publishText: (id, payload, options) => { callbacks = options; return true; } });
  const pending = cancel();
  expect(f.notes.listHeld('restart-a')).toHaveLength(2);
  if (outcome === 'evicted') {
    callbacks.onEvicted();
    await expect(pending).rejects.toThrow('evicted');
    expect(f.notes.listHeld('restart-a')).toHaveLength(2);
  } else {
    callbacks.onLocalSendComplete();
    await Promise.resolve();
    expect(f.notes.listHeld('restart-a').map(note => note.convoId)).toEqual(['bob']);
    callbacks.onLocalSendComplete();
    await pending;
    expect(f.state.getState().state).toBe('cancelled');
  }
});

it('resumes durable cancellation during boot without delivering restart turns', async () => {
  const f = fixture({ patch: { state: 'cancelling', cancel_participants: ['alice', 'bob'], cancel_done: [] } });
  const cancel = createRestartCancellation({ stateStore: f.state, notesStore: f.notes,
    publishText: (id, payload, options) => { options.onLocalSendComplete(); return true; } });
  const resume = vi.fn(cancel);
  const boot = f.boot({ resumeCancel: resume });
  boot.reconcile(); boot.listenerReady();
  await Promise.resolve(); await cancel();
  expect(resume).toHaveBeenCalledOnce();
  expect(f.state.getState().state).toBe('cancelled');
  expect(f.calls).toEqual([]);
  expect(f.notes.listHeld('restart-a')).toEqual([]);
});

it('retries a known deferral after a pending write fails once', async () => {
  const f = fixture({ participants: ['alice'] });
  const deliver = vi.fn().mockResolvedValueOnce({ deferred: true }).mockResolvedValue(true);
  let failed = false;
  start(f, { deliver, notesStore: { ...f.notes, putPending: entry => {
    if (entry.status === 'pending' && !failed) { failed = true; throw new Error('write refused'); }
    f.notes.putPending(entry);
  } } });
  await vi.advanceTimersByTimeAsync(15000);
  expect(failed).toBe(true);
  expect(f.notes.listPending()[0].status).toBe('delivering');
  await drain(f);
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(f.state.getState().verdicts.alice.outcome).toBe('resumed');
  expect(f.history()).toHaveLength(1);
});

it('retries history after the last pending note has been removed', async () => {
  const f = fixture({ participants: ['alice'] });
  const append = vi.fn().mockImplementationOnce(() => { throw new Error('append refused'); })
    .mockImplementation((...args) => f.state.appendHistoryOnce(...args));
  start(f, { history: { appendHistoryOnce: append } });
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.notes.listPending()).toEqual([]);
  expect(f.state.getState()).toMatchObject({ state: 'back', history_appended: false });
  await drain(f);
  expect(f.state.getState().history_appended).toBe(true);
  expect(f.history()).toHaveLength(1);
  expect(f.calls).toHaveLength(1);
});
