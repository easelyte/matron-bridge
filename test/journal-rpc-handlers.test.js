import { describe, it, expect } from 'vitest';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';

const silentLog = { warn: () => {}, error: () => {} };
const REQ = (method, params, id = 'r1') => ({ request_id: id, from_device_id: 7, method, params });

function harness(overrides = {}) {
  const responses = [];
  const handler = createRpcRequestHandler({
    respondRpc: (args) => responses.push(args),
    startSession: () => ({ claudeSessionId: 'session-uuid-1' }),
    stopSession: () => {},
    listPersistedSessions: () => [],
    defaultWorkdir: '/home/dan',
    expandHome: (p) => p.replace(/^~(?=\/|$)/, '/home/dan'),
    statSync: () => ({ isDirectory: () => true }),
    log: silentLog,
    ...overrides,
  });
  return { handler, responses };
}

describe('recent_folders', () => {
  it('dedupes by workdir keeping max lastUsed, sorts newest-first, caps at 20, appends default', () => {
    const records = [];
    for (let i = 0; i < 25; i++) records.push({ workdir: `/w/${i}`, lastUsed: 1000 + i });
    records.push({ workdir: '/w/24', lastUsed: 5 });          // duplicate, older — must not demote /w/24
    records.push({ workdir: '', lastUsed: 99999 });           // junk — skipped
    records.push({ notAWorkdir: true });                      // junk — skipped
    const { handler, responses } = harness({ listPersistedSessions: () => records });
    handler(REQ('recent_folders', {}));
    expect(responses).toHaveLength(1);
    const { ok, result } = responses[0];
    expect(ok).toBe(true);
    expect(result.folders).toHaveLength(21); // 20 capped history + appended default
    expect(result.folders[0]).toEqual({ path: '/w/24', last_used: 1024 });
    expect(result.folders[19]).toEqual({ path: '/w/5', last_used: 1005 });
    expect(result.folders[20]).toEqual({ path: '/home/dan', last_used: null });
  });

  it('does not duplicate the default workdir when history already has it', () => {
    const { handler, responses } = harness({
      listPersistedSessions: () => [{ workdir: '/home/dan', lastUsed: 42 }],
    });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.folders).toEqual([{ path: '/home/dan', last_used: 42 }]);
  });

  it('a record without lastUsed surfaces as last_used null and sorts last', () => {
    const { handler, responses } = harness({
      listPersistedSessions: () => [{ workdir: '/a' }, { workdir: '/b', lastUsed: 10 }],
    });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.folders.map((f) => f.path)).toEqual(['/b', '/a', '/home/dan']);
    expect(responses[0].result.folders[1].last_used).toBe(null);
  });

  it('merges remembered folders with session records, newest timestamp winning', () => {
    const { handler, responses } = harness({
      listPersistedSessions: () => [{ workdir: '/w/both', lastUsed: 50 }, { workdir: '/w/sess', lastUsed: 10 }],
      listRememberedFolders: () => [{ path: '/w/both', lastUsed: 200 }, { path: '/w/gone-session', lastUsed: 100 }],
    });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.folders).toEqual([
      { path: '/w/both', last_used: 200 },
      { path: '/w/gone-session', last_used: 100 },
      { path: '/w/sess', last_used: 10 },
      { path: '/home/dan', last_used: null },
    ]);
  });

  it('remembered folders alone survive an emptied session store', () => {
    const { handler, responses } = harness({
      listPersistedSessions: () => [],
      listRememberedFolders: () => [{ path: '/w/kept', lastUsed: 7 }],
    });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.folders).toEqual([
      { path: '/w/kept', last_used: 7 },
      { path: '/home/dan', last_used: null },
    ]);
  });

  it('drops folders that no longer exist on disk, but never the default workdir', () => {
    const { handler, responses } = harness({
      listPersistedSessions: () => [{ workdir: '/w/alive', lastUsed: 3 }, { workdir: '/w/deleted', lastUsed: 5 }],
      listRememberedFolders: () => [{ path: '/w/deleted', lastUsed: 9 }, { path: '/w/now-a-file', lastUsed: 8 }],
      statSync: (p) => {
        if (p === '/w/deleted') { throw new Error('ENOENT'); }
        return { isDirectory: () => p !== '/w/now-a-file' };
      },
    });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.folders).toEqual([
      { path: '/w/alive', last_used: 3 },
      { path: '/home/dan', last_used: null },
    ]);
  });

  it('dead folders do not consume cap slots', () => {
    const records = [];
    for (let i = 0; i < 25; i++) records.push({ workdir: `/dead/${i}`, lastUsed: 9000 + i });
    for (let i = 0; i < 5; i++) records.push({ workdir: `/live/${i}`, lastUsed: 100 + i });
    const { handler, responses } = harness({
      listPersistedSessions: () => records,
      statSync: (p) => { if (p.startsWith('/dead/')) throw new Error('ENOENT'); return { isDirectory: () => true }; },
    });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.folders.map((f) => f.path)).toEqual(
      ['/live/4', '/live/3', '/live/2', '/live/1', '/live/0', '/home/dan'],
    );
  });
});

describe('start', () => {
  it('happy path: resolves ~ workdir, passes mcpExtras, responds with claudeSessionId (never the room key)', () => {
    const calls = [];
    const { handler, responses } = harness({
      startSession: (args) => { calls.push(args); return { claudeSessionId: 'the-real-convo-id' }; },
    });
    handler(REQ('start', { workdir: '~/yearbook-app', browser: true }));
    expect(calls).toEqual([{ workdir: '/home/dan/yearbook-app', mcpExtras: ['browser'] }]);
    expect(responses).toEqual([{ requestId: 'r1', toDeviceId: 7, ok: true, result: { convo_id: 'the-real-convo-id' } }]);
  });

  it('omitted workdir uses the default; browser omitted means no extras', () => {
    const calls = [];
    const { handler } = harness({
      startSession: (args) => { calls.push(args); return { claudeSessionId: 'x' }; },
    });
    handler(REQ('start', {}));
    handler(REQ('start', undefined, 'r2')); // non-object params treated as {}
    expect(calls).toEqual([
      { workdir: '/home/dan', mcpExtras: [] },
      { workdir: '/home/dan', mcpExtras: [] },
    ]);
  });

  it('bad_workdir on a missing or non-directory path, with the resolved path as detail', () => {
    const { handler, responses } = harness({
      statSync: () => { throw new Error('ENOENT'); },
    });
    handler(REQ('start', { workdir: '/nope' }));
    expect(responses[0]).toEqual({ requestId: 'r1', toDeviceId: 7, ok: false, error: { code: 'bad_workdir', detail: '/nope' } });

    const { handler: h2, responses: r2 } = harness({
      statSync: () => ({ isDirectory: () => false }),
    });
    h2(REQ('start', { workdir: '/a-file' }));
    expect(r2[0].error.code).toBe('bad_workdir');
  });

  it('spawn_failed when startSession throws', () => {
    const { handler, responses } = harness({
      startSession: () => { throw new Error('claude not found'); },
    });
    handler(REQ('start', {}));
    expect(responses[0].error).toEqual({ code: 'spawn_failed', detail: 'claude not found' });
  });

  it('prefers the stable journalConvoId over claudeSessionId when both are set', () => {
    const { handler, responses } = harness({
      startSession: () => ({ journalConvoId: 'stable-convo-id', claudeSessionId: 'native-session-id' }),
    });
    handler(REQ('start', {}));
    expect(responses[0]).toEqual({ requestId: 'r1', toDeviceId: 7, ok: true, result: { convo_id: 'stable-convo-id' } });
  });

  it('unsupported_mode tears the session down when claudeSessionId is missing', () => {
    const stopped = [];
    const orphan = { claudeSessionId: null };
    const { handler, responses } = harness({
      startSession: () => orphan,
      stopSession: (s) => stopped.push(s),
    });
    handler(REQ('start', {}));
    expect(stopped).toEqual([orphan]);
    expect(responses[0].error.code).toBe('unsupported_mode');
  });
});

describe('dispatch guarantees', () => {
  it('unknown methods answer unknown_method', () => {
    const { handler, responses } = harness();
    handler(REQ('stop_session', {}));
    expect(responses[0]).toEqual({ requestId: 'r1', toDeviceId: 7, ok: false, error: { code: 'unknown_method' } });
  });

  it('prototype-inherited method names answer unknown_method, never drop', () => {
    const { handler, responses } = harness();
    const methods = ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf', 'isPrototypeOf'];
    for (const m of methods) handler(REQ(m, {}, m));
    expect(responses).toHaveLength(methods.length);
    for (const r of responses) expect(r.error).toEqual({ code: 'unknown_method' });
  });

  it('a nullish throw still answers exactly one internal response', () => {
    const { handler, responses } = harness({
      listPersistedSessions: () => { throw null; },
    });
    handler(REQ('recent_folders', {}));
    expect(responses).toHaveLength(1);
    expect(responses[0].error).toEqual({ code: 'internal', detail: 'null' });
  });

  it('a handler-internal throw answers exactly one internal response', () => {
    const { handler, responses } = harness({
      listPersistedSessions: () => { throw new Error('store corrupt'); },
    });
    handler(REQ('recent_folders', {}));
    expect(responses).toHaveLength(1);
    expect(responses[0].error).toEqual({ code: 'internal', detail: 'store corrupt' });
  });

  it('every branch responds exactly once to from_device_id', () => {
    const { handler, responses } = harness();
    handler(REQ('recent_folders', {}, 'a'));
    handler(REQ('start', {}, 'b'));
    handler(REQ('nope', {}, 'c'));
    expect(responses.map((r) => [r.requestId, r.toDeviceId])).toEqual([['a', 7], ['b', 7], ['c', 7]]);
  });
});
