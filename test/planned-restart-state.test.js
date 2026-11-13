import { describe, expect, it } from 'vitest';
import { createPlannedRestartState } from '../lib/planned-restart-state.js';

function fakeFs(initial) {
  const files = new Map(initial ? [['state', initial]] : []);
  return {
    files,
    readFileSync: file => {
      if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFileSync: (file, data) => { files.set(file, data); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    chmodSync: () => {},
    unlinkSync: file => { files.delete(file); },
  };
}

function make(options = {}) {
  const fs = options.fs ?? fakeFs();
  let t = 1000;
  let n = 0;
  const pending = [];
  const store = createPlannedRestartState({ fs, file: 'state', now: () => (t += 10), makeId: () => `r${++n}`,
    onPending: state => pending.push(state.id), ...options });
  return { store, fs, pending };
}

describe('planned restart state', () => {
  it('starts empty and persists before acknowledging a first request', () => {
    const { store, fs, pending } = make();
    expect(store.getState().state).toBeNull();
    const acked = [];
    const result = store.addRequest({ request_key: 'a', reason: 'update', sha: 'abc' }, {
      ack: r => acked.push([r, JSON.parse(fs.files.get('state')).requests.length]),
    });
    expect(result).toEqual({ id: 'r1', state: 'pending' });
    expect(acked).toEqual([[{ id: 'r1', state: 'pending' }, 1]]);
    expect(pending).toEqual(['r1']);
    expect(store.getState()).toMatchObject({ id: 'r1', state: 'pending', first_request_at: 1010, last_request_at: 1010 });
  });

  it('does not acknowledge a request the file cannot hold', () => {
    const fs = fakeFs();
    fs.writeFileSync = () => { throw new Error('ENOSPC'); };
    const { store } = make({ fs });
    const acked = [];
    expect(() => store.addRequest({ request_key: 'a' }, { ack: r => acked.push(r) })).toThrow('ENOSPC');
    expect(acked).toEqual([]);
  });

  it('joins a pending restart, deduplicates by request key and moves the collect window', () => {
    const { store, pending } = make();
    store.addRequest({ request_key: 'a', reason: 'one' });
    const first = store.getState();
    expect(store.addRequest({ request_key: 'b', reason: 'two' })).toEqual({ id: 'r1', state: 'pending' });
    expect(store.addRequest({ request_key: 'b', reason: 'two again' })).toEqual({ id: 'r1', state: 'pending' });
    const state = store.getState();
    expect(state.requests.map(r => r.request_key)).toEqual(['a', 'b']);
    expect(state.first_request_at).toBe(first.first_request_at);
    expect(state.last_request_at).toBeGreaterThan(first.last_request_at);
    expect(pending).toEqual(['r1']);
  });

  it('refuses requests while the restart is latched, naming its id', () => {
    const { store } = make();
    store.addRequest({ request_key: 'a' });
    store.setState('restarting', { restarting_at: 5 });
    expect(store.addRequest({ request_key: 'b' })).toEqual({ busy: 'restarting', id: 'r1' });
    expect(store.getState().requests).toHaveLength(1);
  });

  it('starts a new restart after the last one is back, keeping the booted sha', () => {
    const { store, pending } = make();
    store.persistBootSha('sha1');
    store.addRequest({ request_key: 'a' });
    store.setState('back', { results: { resumed: [] } });
    expect(store.addRequest({ request_key: 'b' })).toEqual({ id: 'r2', state: 'pending' });
    expect(store.getState()).toMatchObject({ boot_sha: 'sha1', requests: [expect.objectContaining({ request_key: 'b' })], results: null });
    expect(pending).toEqual(['r1', 'r2']);
  });

  it('notifies when an un-latched restart returns to pending', () => {
    const { store, pending } = make();
    store.addRequest({ request_key: 'a' });
    store.setState('restarting');
    store.setState('pending');
    expect(pending).toEqual(['r1', 'r1']);
  });

  it('records who has been told once per restart, and only while pending', () => {
    const { store } = make();
    store.addRequest({ request_key: 'a' });
    store.markNotified('r1', 'alice');
    store.markNotified('r1', 'alice');
    expect(Object.keys(store.getState().notified)).toEqual(['alice']);
    expect(() => store.markNotified('other', 'bob')).toThrow('Invalid restart notice');
    expect(() => store.markNotified('r1', '')).toThrow('Invalid restart notice');
    store.setState('restarting');
    expect(() => store.markNotified('r1', 'bob')).toThrow('Invalid restart notice');
  });

  it('starts each restart with nobody told, and reads a file written before notices existed', () => {
    const { store } = make();
    store.addRequest({ request_key: 'a' });
    store.markNotified('r1', 'alice');
    store.setState('back');
    store.addRequest({ request_key: 'b' });
    expect(store.getState().notified).toEqual({});
    const old = make({ fs: fakeFs('{"id":"r0","state":"pending","requests":[],"participants":[]}') });
    expect(old.store.getState().notified).toEqual({});
  });

  it('keeps the first boot sha for the life of the process', () => {
    const { store } = make();
    store.persistBootSha('sha1');
    store.persistBootSha('sha2');
    expect(store.getState().boot_sha).toBe('sha1');
  });

  it('rejects a malformed file and an invalid request', () => {
    const { store } = make({ fs: fakeFs('{"state":"bogus","requests":[],"participants":[]}') });
    expect(() => store.getState()).toThrow('Invalid restart state');
    expect(() => make().store.addRequest({ reason: 'no key' })).toThrow('Invalid restart request key');
  });
});
