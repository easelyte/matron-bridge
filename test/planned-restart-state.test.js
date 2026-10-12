import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlannedRestartState } from '../lib/planned-restart-state.js';

const file = 'state.json';
const historyFile = 'history.jsonl';
const request = { request_key: 'alice', reason: 'update', sha: 'new' };
function snapshot(patch = {}) {
  return {
    id: 'restart-a', state: 'pending', requests: [request], pending_since: 100,
    first_request_at: 100, last_request_at: 100, boot_sha: 'old', previous_sha: null,
    expected_sha: null, participants: [], notified: {}, verdicts: {},
    history_appended: false, stamp_written: false, ...patch,
  };
}
function fakeFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    readFileSync: vi.fn(p => {
      if (!(p in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[p];
    }),
    writeFileSync: vi.fn((p, data) => { files[p] = data; }),
    renameSync: vi.fn((from, to) => { files[to] = files[from]; delete files[from]; }),
    unlinkSync: vi.fn(p => { delete files[p]; }),
    appendFileSync: vi.fn((p, data) => { files[p] = (files[p] || '') + data; }),
  };
}
function setup(state) {
  const io = fakeFs(state ? { [file]: JSON.stringify(state) } : {});
  const store = createPlannedRestartState({ fs: io, file, historyFile, now: () => 200, makeId: () => 'restart-b' });
  return { io, store };
}
const dirs = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('planned restart state', () => {
  it('persists the complete pending record before acknowledging', () => {
    const { io, store } = setup();
    const ack = vi.fn(result => {
      expect(JSON.parse(io.files[file]).id).toBe(result.id);
      expect(io.renameSync).toHaveBeenCalled();
    });
    const result = store.addRequest(request, ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(result).toEqual({ id: 'restart-b', state: 'pending' });
    expect(store.getState()).toEqual(snapshot({
      id: 'restart-b', pending_since: 200, first_request_at: 200,
      last_request_at: 200, boot_sha: null,
    }));
    expect(io.writeFileSync.mock.calls[0][2]).toEqual({ flush: true, mode: 0o600 });
  });

  it.each(['writeFileSync', 'renameSync'])('refuses acknowledgement when %s fails', method => {
    const { io, store } = setup(snapshot());
    const prior = io.files[file];
    const ack = vi.fn();
    io[method].mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(() => store.addRequest({ request_key: 'bob' }, ack)).toThrow('storage unavailable');
    expect(ack).not.toHaveBeenCalled();
    expect(io.files[file]).toBe(prior);
    expect(store.getState()).toEqual(snapshot());
  });

  it('keeps request keys idempotent across retries and reopened stores', () => {
    const { io, store } = setup(snapshot());
    for (const key of ['alice', 'bob', 'bob', 'alice', 'bob']) {
      store.addRequest({ request_key: key });
    }
    const reopened = createPlannedRestartState({ fs: io, file, historyFile });
    const before = io.files[file];
    reopened.addRequest({ request_key: 'bob', reason: 'different' });
    expect(io.files[file]).toBe(before);
    expect(reopened.getState().requests.map(r => r.request_key)).toEqual(['alice', 'bob']);
    expect(io.renameSync).toHaveBeenCalledTimes(1);
    expect(reopened.getState()).toMatchObject({ pending_since: 100, first_request_at: 100, last_request_at: 200 });
  });

  it('refuses new and repeated requests from persisted restarting state', () => {
    const { io, store } = setup(snapshot());
    io.files[file] = JSON.stringify(snapshot({ state: 'restarting', participants: ['alice'] }));
    const before = io.files[file];
    for (const key of ['alice', 'bob']) {
      expect(store.addRequest({ request_key: key })).toEqual({ busy: 'restarting', id: 'restart-a' });
    }
    expect(io.files[file]).toBe(before);
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });

  it.each(['back', 'cancelled', 'abandoned'])('starts a fresh record after %s', state => {
    const { store } = setup(snapshot({ state, history_appended: true, stamp_written: true, participants: ['alice'] }));
    expect(store.addRequest({ request_key: 'bob' })).toEqual({ id: 'restart-b', state: 'pending' });
    expect(store.getState()).toMatchObject({ requests: [{ request_key: 'bob' }], participants: [], history_appended: false, stamp_written: false, boot_sha: 'old' });
  });

  it('persists boot sha without requests and keeps the captured sha within one boot', () => {
    const { io, store } = setup();
    store.persistBootSha('old');
    expect(store.getState()).toMatchObject({ id: null, state: null, boot_sha: 'old' });
    const before = io.files[file];
    store.persistBootSha('moved');
    expect(store.getState().boot_sha).toBe('old');
    expect(io.files[file]).toBe(before);
    store.addRequest(request);
    expect(store.getState().boot_sha).toBe('old');
    const nextBoot = createPlannedRestartState({ fs: io, file, historyFile });
    nextBoot.persistBootSha('new');
    expect(nextBoot.getState().boot_sha).toBe('new');
  });

  it('allows a boot sha retry after a failed durable write', () => {
    const { io, store } = setup(snapshot({ stamp_written: true }));
    io.writeFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => store.persistBootSha('new')).toThrow('disk full');
    expect(store.getState().boot_sha).toBe('old');
    store.persistBootSha('new');
    expect(store.getState().boot_sha).toBe('new');
    expect(store.getState().stamp_written).toBe(false);
  });

  it('writes state patches, boot phases, verdicts and stamp clearing atomically', () => {
    const { io, store } = setup(snapshot());
    store.setState('restarting', { restarting_at: 200, expected_sha: 'new', previous_sha: 'old', participants: ['alice'], notified: { alice: 100 }, stamp_written: true });
    expect(store.getState().state).toBe('restarting');
    store.setBootPhase('booted');
    expect(store.getState()).toMatchObject({ boot_phase: 'booted', booted_at: 200 });
    for (const outcome of ['resumed', 'failed', 'possibly_delivered', 'stale']) {
      store.recordVerdict('alice', outcome);
      expect(store.getState().verdicts.alice).toEqual({ outcome, at: 200 });
    }
    store.clearStampWritten();
    expect(store.getState().stamp_written).toBe(false);
    store.setState('back', { results: { resumed: 1 } });
    expect(store.getState()).toMatchObject({ state: 'back', results: { resumed: 1 }, expected_sha: 'new' });
    expect(io.renameSync).toHaveBeenCalledTimes(8);
  });

  it.each(['pending', 'restarting', 'back'])('preserves the first booted timestamp and phase in %s', state => {
    const { io, store } = setup(snapshot({ state, booted_at: 100, boot_phase: 'delivering' }));
    const before = io.files[file];
    store.setBootPhase('booted');
    expect(io.files[file]).toBe(before);
    expect(store.getState()).toMatchObject({ booted_at: 100, boot_phase: 'delivering' });
  });

  it('advances reconciliation phase while retaining the first boot timestamp', () => {
    const { store } = setup(snapshot({ state: 'restarting', booted_at: 0, boot_phase: 'booted' }));
    store.setBootPhase('delivering');
    expect(store.getState()).toMatchObject({ booted_at: 0, boot_phase: 'delivering' });
    store.setBootPhase('booted');
    expect(store.getState()).toMatchObject({ booted_at: 0, boot_phase: 'delivering' });
  });

  it('does not mark a pending boot as booted', () => {
    const { io, store } = setup(snapshot());
    store.setBootPhase('booted');
    expect(io.writeFileSync).not.toHaveBeenCalled();
    expect(store.getState().booted_at).toBeUndefined();
  });

  it.each(['setState', 'setBootPhase', 'recordVerdict', 'clearStampWritten'])('surfaces storage failure from %s without losing state', method => {
    const { io, store } = setup(snapshot({ state: 'restarting', stamp_written: true }));
    const prior = io.files[file];
    io.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });
    const args = { setState: ['back'], setBootPhase: ['booted'], recordVerdict: ['alice', 'resumed'], clearStampWritten: [] };
    expect(() => store[method](...args[method])).toThrow('disk full');
    expect(io.files[file]).toBe(prior);
  });

  it.each(['EACCES', 'EIO', 'ETIMEDOUT'])('refuses unreadable state with %s', code => {
    const { io, store } = setup(snapshot());
    io.readFileSync.mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    expect(() => store.addRequest(request)).toThrow(code);
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });

  it.each(['{', 'null', '[]', '{}'])('refuses malformed state %s', raw => {
    const { io, store } = setup();
    io.files[file] = raw;
    expect(() => store.addRequest(request)).toThrow();
    expect(io.files[file]).toBe(raw);
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });

  it.each([null, {}, { request_key: '' }])('refuses an invalid request %j', input => {
    const { io, store } = setup();
    expect(() => store.addRequest(input)).toThrow();
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });

  it('persists an unknown boot SHA without replacing it later', () => {
    const { store } = setup(snapshot({ stamp_written: true }));
    expect(() => store.persistBootSha(null)).not.toThrow();
    expect(store.getState().boot_sha).toBe(null);
    expect(store.getState().stamp_written).toBe(false);
    store.persistBootSha('new');
    expect(store.getState().boot_sha).toBe(null);
  });

  it('refuses invalid state, verdict and boot sha inputs', () => {
    const { io, store } = setup(snapshot());
    expect(() => store.setState('unknown')).toThrow();
    expect(() => store.setState('back', null)).toThrow();
    expect(() => store.setBootPhase(null)).toThrow();
    expect(() => store.recordVerdict(null, 'resumed')).toThrow();
    expect(() => store.recordVerdict('alice', 'unknown')).toThrow();
    expect(() => store.persistBootSha(undefined)).toThrow();
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });

  it.each([true, false])('appends exactly one history line with prior newline %s', newline => {
    const { io, store } = setup(snapshot({ state: 'back' }));
    const older = JSON.stringify({ id: 'restart-old', results: {} }) + (newline ? '\n' : '');
    io.files[historyFile] = older;
    store.appendHistoryOnce('restart-a', { results: { resumed: 1 } });
    expect(io.appendFileSync).toHaveBeenCalledOnce();
    store.appendHistoryOnce('restart-a', { results: { resumed: 1 } });
    expect(io.files[historyFile]).toBe(older + (newline ? '' : '\n') + JSON.stringify({ results: { resumed: 1 }, id: 'restart-a' }) + '\n');
    expect(store.getState().history_appended).toBe(true);
    expect(io.appendFileSync).toHaveBeenCalledOnce();
  });

  it('recovers an append committed before the state flag write', () => {
    const { io, store } = setup(snapshot({ state: 'abandoned' }));
    io.writeFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => store.appendHistoryOnce('restart-a', { abandoned: true })).toThrow('disk full');
    expect(store.getState().history_appended).toBe(false);
    const reopened = createPlannedRestartState({ fs: io, file, historyFile });
    reopened.appendHistoryOnce('restart-a', { abandoned: true });
    expect(io.files[historyFile].trim().split('\n')).toHaveLength(1);
    expect(io.appendFileSync).toHaveBeenCalledOnce();
    expect(reopened.getState().history_appended).toBe(true);
  });

  it('repairs a partial append on reopen and preserves completed history', () => {
    const { io, store } = setup(snapshot({ state: 'back' }));
    const older = JSON.stringify({ id: 'restart-old', results: { resumed: 1 } }) + '\n';
    io.files[historyFile] = older;
    io.appendFileSync.mockImplementationOnce((p, data) => {
      io.files[p] += data.slice(0, 8);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    expect(() => store.appendHistoryOnce('restart-a', { results: {} })).toThrow('disk full');
    expect(io.files[historyFile]).toBe(older + '{"result');
    expect(store.getState().history_appended).toBe(false);
    const reopened = createPlannedRestartState({ fs: io, file, historyFile });
    expect(() => reopened.appendHistoryOnce('restart-a', { results: {} })).not.toThrow();
    reopened.appendHistoryOnce('restart-a', { results: {} });
    expect(io.files[historyFile]).toBe(older + '{"results":{},"id":"restart-a"}\n');
    expect(io.appendFileSync).toHaveBeenCalledTimes(2);
    expect(reopened.getState().history_appended).toBe(true);
  });

  it('surfaces corrupt completed history before repairing a partial tail', () => {
    const { io, store } = setup(snapshot({ state: 'back' }));
    const raw = '{"id":"restart-old"}\n{\n{"id":"restart-older"}\n{"result';
    io.files[historyFile] = raw;
    expect(() => store.appendHistoryOnce('restart-a', {})).toThrow();
    expect(io.files[historyFile]).toBe(raw);
    expect(io.writeFileSync).not.toHaveBeenCalled();
    expect(io.appendFileSync).not.toHaveBeenCalled();
    expect(store.getState().history_appended).toBe(false);
  });

  it.each(['read', 'append', 'malformed', 'invalid entry', 'wrong id'])('refuses history %s failure without setting the flag', fault => {
    const { io, store } = setup(snapshot({ state: 'back' }));
    if (fault === 'read') io.readFileSync.mockImplementation(p => {
      if (p === historyFile) throw new Error('unreadable');
      return io.files[p];
    });
    if (fault === 'append') io.appendFileSync.mockImplementation(() => { throw new Error('disk full'); });
    if (fault === 'malformed') io.files[historyFile] = '{\n';
    if (fault === 'invalid entry') io.files[historyFile] = '{}\n';
    expect(() => store.appendHistoryOnce(fault === 'wrong id' ? 'other' : 'restart-a', {})).toThrow();
    expect(store.getState().history_appended).toBe(false);
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });

  it('resolves default state and history paths from HOME at factory call time', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-state-'));
    dirs.push(dir);
    vi.stubEnv('HOME', dir);
    const io = fakeFs();
    const store = createPlannedRestartState({ fs: io, makeId: () => 'restart-a' });
    store.persistBootSha('old');
    expect(Object.keys(io.files)).toEqual([path.join(dir, '.matron-bridge-restart-state.json')]);
    store.addRequest(request);
    store.setState('back');
    store.appendHistoryOnce('restart-a', {});
    expect(io.files[path.join(dir, '.matron-bridge-restart-history.jsonl')]).toBe('{"id":"restart-a"}\n');
  });
});
