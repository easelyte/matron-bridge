import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPlannedRestartState } from '../lib/planned-restart-state.js';
import { createRestartNotes } from '../lib/restart-notes.js';
import { createRestartBoot, takeNoteOnlyRecoveries } from '../lib/restart-boot.js';
import { createRestartLatch } from '../lib/restart-latch.js';

const roots = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000000); });
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture({ requests = [{ request_key: 'r1', sha: 'code-a' }], state = 'pending', patch = {}, held = ['alice'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-lows-'));
  roots.push(root);
  const stateOptions = { file: path.join(root, 'state.json'), historyFile: path.join(root, 'history.jsonl'), makeId: () => 'restart-a' };
  const notesOptions = { heldFile: path.join(root, 'held.json'), pendingFile: path.join(root, 'pending.json') };
  const store = createPlannedRestartState(stateOptions);
  const notes = createRestartNotes(notesOptions);
  for (const request of requests) store.addRequest(request);
  if (state !== 'pending') store.setState(state, patch);
  for (const convoId of held) notes.hold('restart-a', convoId, `Continue ${convoId}`);
  const calls = [];
  const logs = [];
  const boot = () => createRestartBoot({
    stateStore: createPlannedRestartState(stateOptions), notesStore: createRestartNotes(notesOptions),
    markerStore: { list: () => ({ alice: { bootId: 'previous' } }) },
    bootId: 'current', bootSha: 'code-a', maxAgeMs: 1000000, takeStamp: () => null,
    deliver: async entry => { calls.push(entry); return true; }, log: text => logs.push(text),
  });
  return { store, notes, calls, logs, boot, stateOptions };
}
const run = async f => {
  const boot = f.boot();
  boot.reconcile();
  boot.listenerReady();
  await vi.runAllTimersAsync();
  return boot;
};

// A pending request for the sha this boot already runs.
it('drops a pending request already satisfied by an unplanned restart and delivers no continuation', async () => {
  const f = fixture();
  const boot = await run(f);
  expect(f.store.getState().state).toBe('cancelled');
  expect(f.store.getState().requests).toEqual([]);
  expect(f.notes.listHeld('restart-a')).toEqual([]);
  expect(f.notes.listPending()).toEqual([]);
  expect(f.calls, 'no planned-restart continuation').toEqual([]);
  // The legacy in-flight card path stays the single continuation for alice.
  expect(boot.suppressCard('alice', 'previous')).toBe(false);
  expect(f.logs.join('\n')).toMatch(/already satisfied/);
});

it('keeps requests for other shas pending and only drops the satisfied one', async () => {
  const f = fixture({ requests: [{ request_key: 'r1', sha: 'code-a' }, { request_key: 'r2', sha: 'code-b' }] });
  await run(f);
  const state = f.store.getState();
  expect(state.state).toBe('pending');
  expect(state.requests.map(r => r.request_key)).toEqual(['r2']);
  expect(f.notes.listHeld('restart-a')).toHaveLength(1);
  expect(f.calls).toEqual([]);
});

it('leaves a pending request for a different sha untouched', async () => {
  const f = fixture({ requests: [{ request_key: 'r1', sha: 'code-b' }] });
  await run(f);
  expect(f.store.getState().state).toBe('pending');
  expect(f.store.getState().requests).toHaveLength(1);
});

// A latch left on disk by a failed un-latch.
const latched = { restarting_at: 999000, expected_sha: 'code-a', participants: ['alice'], stamp_written: true, notified: { alice: {} } };

it('reverts a restarting latch that never committed shutdown', async () => {
  const f = fixture({ requests: [{ request_key: 'r1', sha: 'code-b' }], state: 'restarting', patch: { ...latched, shutdown_committed_at: null } });
  await run(f);
  const state = f.store.getState();
  expect(state.state).toBe('pending');
  expect(state.participants).toEqual([]);
  expect(state.shutdown_committed_at).toBeUndefined();
  expect(f.calls, 'no resume note for a restart that never happened').toEqual([]);
  expect(f.notes.listHeld('restart-a')).toHaveLength(1);
  expect(f.logs.join('\n')).toMatch(/stale latch/);
});

it.each([['committed', 999500], ['legacy state without the field', undefined]])('still resumes a genuine planned restart (%s)', async (_name, committed) => {
  const f = fixture({ requests: [{ request_key: 'r1', sha: 'code-b' }], state: 'restarting',
    patch: { ...latched, ...(committed === undefined ? {} : { shutdown_committed_at: committed }) } });
  await run(f);
  expect(f.calls.map(c => c.convoId)).toEqual(['alice']);
});

function latchFixture({ failCommit = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-lows-latch-'));
  roots.push(root);
  const stateStore = createPlannedRestartState({ file: path.join(root, 'state.json'), makeId: () => 'restart-a', now: () => 400000 });
  stateStore.persistBootSha('boot');
  stateStore.addRequest({ request_key: 'r1' });
  const patch = stateStore.patch.bind(stateStore);
  stateStore.patch = value => {
    if (failCommit && 'shutdown_committed_at' in value) throw new Error('disk');
    return patch(value);
  };
  const shutdown = vi.fn();
  const key = { sha: 'head', env_hash: 'e', deps_stamp: 'd' };
  const latch = createRestartLatch({
    stateStore, runtime: { stamped: false }, bootId: 'box', now: () => 400000,
    quiet: () => ({ quiet: true, holders: [], probe_error: null }),
    readCode: () => ({ sha: 'head', code: null }), cacheKey: () => key,
    getPreflight: () => ({ status: 'ok', key, at: 400000 }),
    listHeld: () => [], listMarkers: () => ({}), writeStamp: () => {}, deleteStamp: () => {},
    publishRestartStatus: () => {}, gracefulShutdown: shutdown,
  });
  return { latch, stateStore, shutdown };
}

it('stamps the latch as uncommitted, then commits it durably before shutdown', () => {
  const f = latchFixture();
  const seen = [];
  f.shutdown.mockImplementation(() => seen.push(f.stateStore.getState().shutdown_committed_at));
  expect(f.latch.onReady({ sha: 'head', key: {}, state: f.stateStore.getState() }).latched).toBe(true);
  expect(seen, 'commit is on disk when shutdown starts').toEqual([400000]);
});

it('refuses shutdown and un-latches when the commit write fails', () => {
  const f = latchFixture({ failCommit: true });
  expect(f.latch.onReady({ sha: 'head', key: {}, state: f.stateStore.getState() }).latched).toBe(false);
  expect(f.shutdown).not.toHaveBeenCalled();
  expect(f.stateStore.getState().state).toBe('pending');
});

// Token-file failure at boot: chats that only had a restart note.
it('hands note-only chats a recovery card list and clears their notes', () => {
  const f = fixture({ state: 'restarting', patch: { ...latched, participants: ['alice', 'bob', 'carol'] }, held: [] });
  for (const id of ['alice', 'bob', 'carol']) f.notes.putPending({ id: 'restart-a', convoId: id, text: 't', writtenAt: 1 });
  const ids = takeNoteOnlyRecoveries({ notesStore: f.notes, markerIds: new Set(['alice']), isResumable: id => id !== 'carol' });
  expect(ids, 'alice has a marker card, carol has no session').toEqual(['bob']);
  expect(f.notes.listPending()).toEqual([]);
});

it('index.js publishes one card for a note-only chat and none for a marker chat', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function publishNoteOnlyRecoveryCards(');
  const body = source.slice(start, source.indexOf('\nasync function main()', start));
  const f = fixture({ state: 'restarting', patch: latched, held: [] });
  for (const id of ['alice', 'bob']) f.notes.putPending({ id: 'restart-a', convoId: id, text: 't', writtenAt: 1 });
  const cards = [];
  const file = path.join(roots[roots.length - 1], 'inflight.json');
  fs.writeFileSync(file, JSON.stringify({ alice: { bootId: 'previous' } }));
  const publish = runInNewContext(`${body}\npublishNoteOnlyRecoveryCards`, {
    plannedRestartState: {}, fs, INFLIGHT_FILE: file, takeNoteOnlyRecoveries, createRestartNotes: () => f.notes,
    loadPersistedSessions: () => ({ r1: { journalConvoId: 'alice' }, r2: { journalConvoId: 'bob' } }),
    isResumeConvoId: () => true, console: { warn() {} },
    journalPublishCardForConvo: (convoId, card) => { cards.push([convoId, card.options[0].value]); return true; },
  });
  publish();
  publish();
  expect(cards, 'exactly one card, for bob only').toEqual([['bob', 'resume:bob']]);
});
