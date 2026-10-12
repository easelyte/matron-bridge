import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createRestartLatch } from '../lib/restart-latch.js';
import { createPlannedRestartState } from '../lib/planned-restart-state.js';
import { createRestartNotes } from '../lib/restart-notes.js';
import { createPlannedRestart } from '../lib/planned-restart.js';
import { runInNewContext } from 'node:vm';
import { parse } from 'espree';
import { evaluateQuiet } from '../lib/restart-quiet.js';
import { createJournalMediaRouter } from '../lib/journal-media.js';
import { atomicWriteFileSync } from '../lib/atomic-write.js';

const roots = [];
const steps = ['restarting', 'quiet', 'code', 'persist', 'stamp', 'shutdown'];
const key = sha => ({ sha, env_hash: 'env', deps_stamp: 'deps' });
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture({ step, fault, head = 'head', age = 0, status = 'ok', keyChange, request = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-latch-'));
  roots.push(root);
  const file = path.join(root, 'state.json');
  const stamp = path.join(root, 'stamp.json');
  const stateStore = createPlannedRestartState({ file, makeId: () => 'alice', now: () => 400000 });
  stateStore.persistBootSha('boot');
  stateStore.addRequest({ request_key: 'alice' });
  stateStore.markNotified('alice', 'bob');
  const notes = createRestartNotes({ heldFile: path.join(root, 'held.json'), pendingFile: path.join(root, 'pending.json') });
  notes.hold('alice', 'bob', 'continue');
  notes.hold('other', 'other', 'ignore');
  const order = [];
  const shutdown = vi.fn(() => order.push('shutdown'));
  const dispatched = vi.fn();
  const fail = name => { if (fault === name) throw new Error('unavailable'); };
  const persist = stateStore.setState.bind(stateStore);
  stateStore.setState = (state, patch) => {
    fail(state === 'pending' ? 'unlatch-write' : 'state-write');
    order.push(state);
    return persist(state, patch);
  };
  let latch;
  let joined;
  const deps = {
    stateStore, runtime: { stamped: false }, bootId: 'box-a', now: () => 400000,
    quiet: () => { fail('quiet'); return fault === 'busy' ? { quiet: false, holders: ['bob'], probe_error: null }
      : fault === 'probe' ? { quiet: false, holders: [], probe_error: 'process_table' }
        : fault === 'quiet-null' ? null : { quiet: true, holders: [], probe_error: null }; },
    readCode: () => { fail('git'); return { sha: head, code: fault === 'dirty' ? 'dirty tree' : null }; },
    cacheKey: sha => { fail('key'); return { ...key(sha), ...keyChange }; },
    getPreflight: () => { fail('preflight'); return fault === 'preflight-null' ? null : { status, key: key('head'), at: 400000 - age }; },
    listHeld: id => { fail('notes'); return notes.listHeld(id); },
    listMarkers: () => { fail('markers'); return { alice: {}, bob: {} }; },
    writeStamp: value => { fail('stamp-write'); fs.writeFileSync(stamp, JSON.stringify(value)); },
    deleteStamp: () => {
      expect(stateStore.getState().state, 'persist pending before deleting stamp').toBe('pending');
      order.push('delete'); fail('stamp-delete'); fs.rmSync(stamp, { force: true });
    },
    publishRestartStatus: reason => { expect(reason).toBe('restarting'); order.push('publish'); fail('publish'); },
    log: () => { order.push('log'); fail('log'); },
    gracefulShutdown: shutdown,
    onStep: name => {
      if (name !== step) return;
      if (request) {
        if (latch.beforeRequest()) joined = { busy: 'restarting' };
        else joined = stateStore.addRequest({ request_key: 'bob' });
      } else { latch.onInput(); dispatched(); }
    },
  };
  latch = createRestartLatch(deps);
  const ready = () => latch.onReady({ sha: 'head', key: key('head'), state: stateStore.getState() });
  return { latch, ready, stateStore, file, stamp, shutdown, dispatched, order, notes, deps, get joined() { return joined; } };
}

it.each(steps)('persists pending and dispatches input at %s', step => {
  const f = fixture({ step });
  expect(f.ready().latched).toBe(false);
  const state = JSON.parse(fs.readFileSync(f.file));
  expect(state.state, 'expected pending after input under latch').toBe('pending');
  expect(state).toMatchObject({ restarting_at: null, expected_sha: null, stamp_written: false, boot_phase: null, participants: [],
    requests: [{ request_key: 'alice' }], notified: { bob: { at: 400000, turnEnded: false } } });
  expect(f.notes.listHeld('alice')).toHaveLength(1);
  expect(fs.existsSync(f.stamp)).toBe(false);
  expect(f.shutdown).not.toHaveBeenCalled();
  expect(f.dispatched).toHaveBeenCalledOnce();
  if (['persist', 'stamp', 'shutdown'].includes(step)) {
    atomicWriteFileSync(fileURLToPath(new URL(`./fixtures/bridge-unlatch-${step}.json`, import.meta.url)), JSON.stringify(state, null, 2) + '\n');
  }
});

it('pins the reread head, boot sha, participants, stamp and publish order', () => {
  const f = fixture();
  let reads = 0;
  const verdict = { get sha() { return reads++ === 0 ? 'head' : 'old-evaluation'; }, state: f.stateStore.getState() };
  expect(f.latch.onReady(verdict).latched).toBe(true);
  expect(f.stateStore.getState()).toMatchObject({ state: 'restarting', restarting_at: 400000, expected_sha: 'head', previous_sha: 'boot',
    participants: ['bob', 'alice'], stamp_written: true, history_appended: false });
  expect(JSON.parse(fs.readFileSync(f.stamp))).toEqual({ bootId: 'box-a', sha: 'head', busy: 0, at: 400000 });
  expect(f.shutdown).toHaveBeenCalledWith('planned-restart', { exitCode: 75 });
  expect(f.order.slice(-3)).toEqual(['publish', 'log', 'shutdown']);
});

it.each(['busy', 'probe', 'quiet-null', 'quiet', 'git', 'dirty', 'key', 'preflight', 'preflight-null', 'notes', 'markers', 'state-write', 'stamp-write', 'publish', 'log'])('refuses shutdown when %s fails', fault => {
  const f = fixture({ fault });
  expect(f.ready().latched).toBe(false);
  expect(f.shutdown).not.toHaveBeenCalled();
});
it.each([
  { head: 'moved' }, { keyChange: { env_hash: 'changed' } }, { keyChange: { deps_stamp: 'changed' } },
  { status: 'unknown' }, { status: 'error' }, { status: null }, { age: -1 }, { age: 300000 }, { age: 300001 },
])('refuses stale or mismatched preflight %j', options => {
  const f = fixture(options);
  expect(f.ready().latched).toBe(false);
  expect(f.stateStore.getState().state).toBe('pending');
  expect(f.shutdown).not.toHaveBeenCalled();
});
it('accepts the last fresh millisecond', () => {
  const f = fixture({ age: 299999 });
  expect(f.ready().latched).toBe(true);
  expect(f.shutdown).toHaveBeenCalledOnce();
  expect(f.deps.runtime.stamped).toBe(true);
});
it.each(['unlatch-write', 'stamp-delete'])('refuses shutdown if %s prevents input cleanup', fault => {
  const broken = fixture({ step: 'stamp', fault });
  expect(broken.ready().latched).toBe(false);
  expect(broken.shutdown).not.toHaveBeenCalled();
  if (fault === 'unlatch-write') expect(broken.order).not.toContain('delete');
});
it('joins a request after persistence before the stamp', () => {
  const f = fixture({ step: 'persist', request: true });
  expect(f.ready().latched).toBe(false);
  expect(f.joined).toEqual({ id: 'alice', state: 'pending' });
  expect(f.stateStore.getState().requests.map(r => r.request_key)).toEqual(['alice', 'bob']);
  expect(f.shutdown).not.toHaveBeenCalled();
});
it('rejects a request after the stamp without adding it', () => {
  const f = fixture({ step: 'stamp', request: true });
  expect(f.ready().latched).toBe(true);
  expect(f.joined).toEqual({ busy: 'restarting' });
  expect(f.stateStore.getState().requests).toHaveLength(1);
});
it('rejects persisted restarting after boot without unlatching', () => {
  const f = fixture();
  f.stateStore.setState('restarting');
  const before = fs.readFileSync(f.file, 'utf8');
  expect(f.latch.beforeRequest()).toBe(true);
  f.latch.onInput();
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
});
it('exhaustively checks shutdown implies no input and the reread expected sha', () => {
  for (const step of [undefined, ...steps]) for (const head of ['head', 'moved']) {
    const f = fixture({ step, head });
    const result = f.ready();
    expect(result.latched).toBe(step === undefined && head === 'head');
    if (f.shutdown.mock.calls.length) {
      expect(f.dispatched).not.toHaveBeenCalled();
      expect(f.stateStore.getState().expected_sha).toBe(head);
    }
  }
});
it('refuses a head move between evaluation and latch reread through the gate', async () => {
  const f = fixture({ head: 'moved' });
  const gate = createPlannedRestart({ repoDir: '.', stateStore: f.stateStore, collectMs: 0, now: () => 400000,
    git: args => args[0] === 'rev-parse' ? 'head' : args[0] === 'merge-base' ? true : '',
    fs: { readFileSync: () => Buffer.from('fixture'), statSync: () => ({ ino: 1, mtimeMs: 1 }) },
    quietEvaluator: () => ({ quiet: true, holders: [], probe_error: null }), support: () => 'gate/1',
    preflight: async () => ({ ok: true }), onReady: f.latch.onReady,
  });
  gate.tick(); await Promise.resolve(); gate.tick();
  expect(f.stateStore.getState().state).toBe('pending');
  expect(f.shutdown).not.toHaveBeenCalled();
});
it('wires input choke points and keeps the planned shutdown in the latch', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  for (const name of ['sendToSession', 'createSession', 'journalResumeConvo']) {
    const body = source.slice(source.indexOf(`function ${name}(`)).split('\n').slice(0, 5).join('\n');
    expect(body).toContain(name === 'createSession' ? 'restartLatch?.onInput()' : 'restartLatch?.beginInput()');
  }
  expect(source).toContain('onReady: verdict => restartLatch.onReady(verdict)');
  expect(source).toContain('restartLatch.beforeRequest()');
  expect(source).not.toContain("gracefulShutdown('planned-restart'");
});

it('unlatches through the real session creation entry before spawning', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function createSession(');
  const end = source.indexOf('\n}\n', start) + 2;
  const make = new Function('restartLatch', 'resolveSpawnCwd', 'expandHome', 'DEFAULT_WORKDIR', 'os',
    `${source.slice(start, end)}; return createSession;`);
  const f = fixture();
  const spawn = vi.fn(() => { throw new Error('stop before spawn'); });
  const create = make(f.latch, spawn, value => value, 'fixture', { homedir: () => 'fixture' });
  // Use an injected state write to re-enter the actual function while latched.
  const setState = f.stateStore.setState;
  f.stateStore.setState = (state, patch) => {
    const saved = setState(state, patch);
    if (state === 'restarting' && patch?.stamp_written) expect(() => create('bob', 'fixture')).toThrow('stop before spawn');
    return saved;
  };
  expect(f.ready().latched).toBe(false);
  expect(f.stateStore.getState().state).toBe('pending');
  expect(spawn).toHaveBeenCalledOnce();
  expect(f.shutdown).not.toHaveBeenCalled();
});

it('refuses a cached evaluated key when the reread key differs', () => {
  const f = fixture();
  f.deps.getPreflight = () => ({ status: 'ok', key: key('old'), at: 400000 });
  const latch = createRestartLatch(f.deps);
  expect(latch.onReady({ sha: 'head', key: key('old'), state: f.stateStore.getState() }).latched).toBe(false);
  expect(f.shutdown).not.toHaveBeenCalled();
});

it('joins through the real restart route after persist and before stamping', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const dry = source.indexOf("if (url.pathname === '/restart/dry-run')", source.indexOf('const apiServer ='));
  const start = source.indexOf('    try {', source.indexOf('return;', dry));
  const end = source.indexOf('\n    return;\n  }', start);
  const route = new (Object.getPrototypeOf(async function () {}).constructor)('plannedRestartState', 'restartLatch', 'url', 'data', 'reply', 'randomUUID', source.slice(start, end));
  const f = fixture();
  const reply = vi.fn();
  const persist = f.stateStore.setState;
  f.stateStore.setState = (state, patch) => {
    const saved = persist(state, patch);
    if (state === 'restarting' && patch?.stamp_written) {
      route(f.stateStore, f.latch, { pathname: '/restart' }, { reason: 'config', request_key: 'bob' }, reply, () => 'bob');
    }
    return saved;
  };
  expect(f.ready().latched).toBe(false);
  expect(reply).toHaveBeenCalledWith(200, { id: 'alice', state: 'pending' });
  expect(f.stateStore.getState().requests.map(r => r.request_key)).toEqual(['alice', 'bob']);
  expect(f.shutdown).not.toHaveBeenCalled();
});

it.each(['missing-state', 'unreadable-state', 'null-state', 'null-verdict', 'timeout', 'missing-key', 'missing-cache-key', 'missing-cache-time', 'missing-notes', 'missing-markers'])('fails closed on %s', fault => {
  const f = fixture();
  const verdict = { sha: 'head', key: key('head'), state: f.stateStore.getState() };
  if (fault === 'missing-state' || fault === 'unreadable-state') {
    fs.rmSync(f.file);
    if (fault === 'unreadable-state') fs.mkdirSync(f.file);
  }
  if (fault === 'null-state') f.stateStore.getState = () => null;
  if (fault === 'timeout') f.deps.readCode = () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); };
  if (fault === 'missing-key') f.deps.cacheKey = () => null;
  if (fault === 'missing-cache-key') f.deps.getPreflight = () => ({ status: 'ok', at: 400000 });
  if (fault === 'missing-cache-time') f.deps.getPreflight = () => ({ status: 'ok', key: key('head') });
  if (fault === 'missing-notes') f.deps.listHeld = () => null;
  if (fault === 'missing-markers') f.deps.listMarkers = () => null;
  const latch = createRestartLatch(f.deps);
  expect(latch.onReady(fault === 'null-verdict' ? null : verdict).latched).toBe(false);
  expect(f.shutdown).not.toHaveBeenCalled();
});

it.each(['sendToSession', 'journalResumeConvo'])('unlatches through the real %s entry', name => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  const make = new Function('restartLatch', 'loadPersistedSessions', 'JOURNAL_RESUME_NOTICE',
    `${source.slice(start, end)}; return ${name};`);
  const f = fixture();
  const dispatch = make(f.latch, () => ({}), 'continue');
  const persist = f.stateStore.setState;
  let calls = 0;
  f.stateStore.setState = (state, patch) => {
    const saved = persist(state, patch);
    if (state === 'restarting' && patch?.stamp_written) {
      calls++;
      if (name === 'sendToSession') expect(dispatch({ alive: false }, [])).toBe(false);
      else expect(dispatch('bob')).toBe(null);
    }
    return saved;
  };
  expect(f.ready().latched).toBe(false);
  expect(f.stateStore.getState().state).toBe('pending');
  expect(calls).toBe(1);
  expect(f.shutdown).not.toHaveBeenCalled();
});

it('refuses a moved head even when the reread preflight key matches', () => {
  const f = fixture({ head: 'moved' });
  f.deps.getPreflight = () => ({ status: 'ok', key: key('moved'), at: 400000 });
  const latch = createRestartLatch(f.deps);
  expect(latch.onReady({ sha: 'head', state: f.stateStore.getState() }).latched).toBe(false);
  expect(f.stateStore.getState().state).toBe('pending');
  expect(f.shutdown).not.toHaveBeenCalled();
});

function indexFunction(name, context) {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  return runInNewContext(`${source.slice(start, end)}; ${name}`, context);
}

it('holds room input while foreign context is pending and releases after delivery', async () => {
  const f = fixture();
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const deliver = vi.fn();
  const session = { alive: true, roomId: 'alice' };
  const route = indexFunction('deliverRoomFrameTo', {
    restartLatch: f.latch, sessions: new Map([['alice', session]]),
    personOfSender: () => 'bob', personLabel: () => 'bob',
    maybeFlushRoomDelivery() {}, roomEchoLabel: () => null,
    roomFrameDisposition: () => 'deliver', agentRooms: { isMuted: () => false },
    foreignSessions: { refreshContext: () => pending },
    roomDelivery: { pendingCount: () => 0, deliver },
  });
  const done = route({ sessionRoomId: 'alice' }, { type: 'text', convo_id: 'bob', payload: { body: 'hello' } });
  expect(f.ready().latched, 'context fetch must hold latch').toBe(false);
  expect(f.shutdown).not.toHaveBeenCalled();
  expect(deliver).not.toHaveBeenCalled();
  resolve(); await done;
  expect(deliver).toHaveBeenCalledOnce();
  expect(f.ready().latched, 'delivery releases room holder').toBe(true);
});

it.each(['single', 'incomplete batch'])('holds media input during fetch and delivery: %s', async kind => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    let resolve;
    const fetch = new Promise(r => { resolve = r; });
    const injectBlocks = vi.fn(() => true);
    const route = createJournalMediaRouter({
      beginInput: () => f.latch.beginInput(), fetchMedia: () => fetch,
      buildSavedBlocks: () => [{ type: 'text', text: 'attachment' }],
      injectBlocks, echoToRoom() {}, publishNotice() {}, log: { warn() {} }, batchQuietMs: 100,
    });
    const done = route({ claudeSessionId: 'alice' }, {
      type: 'file', blobRef: 'bob', name: 'attachment',
      ...(kind === 'incomplete batch' ? { batch: { id: 'bob', index: 1, total: 2 } } : {}),
    });
    await Promise.resolve();
    expect(f.ready().latched, 'fetch must hold latch').toBe(false);
    expect(injectBlocks).not.toHaveBeenCalled();
    resolve({ buffer: Buffer.from('attachment'), contentType: 'application/pdf' });
    await done;
    if (kind === 'incomplete batch') {
      expect(f.ready().latched, 'incomplete batch must hold latch').toBe(false);
      expect(injectBlocks).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(injectBlocks).toHaveBeenCalledOnce();
    expect(f.ready().latched, 'delivery releases media holder').toBe(true);
  } finally { vi.useRealTimers(); }
});

it.each(['onInput', 'beforeRequest', 'retryCleanup', 'onReady'])('recovers failed durable cleanup through %s', method => {
  const f = fixture({ step: 'stamp', fault: 'unlatch-write' });
  expect(f.ready().latched).toBe(false);
  expect(f.shutdown).not.toHaveBeenCalled();
  expect(f.deps.runtime.stamped).toBe(true);
  expect(f.stateStore.getState().state).toBe('restarting');
  const persist = createPlannedRestartState({ file: f.file }).setState;
  f.stateStore.setState = persist;
  if (method === 'onReady') f.ready();
  else f.latch[method]();
  expect(f.stateStore.getState().state, 'writable storage must recover pending').toBe('pending');
  expect(f.deps.runtime.stamped).toBe(false);
  expect(fs.existsSync(f.stamp)).toBe(false);
  expect(f.latch.beforeRequest()).toBe(false);
  expect(f.shutdown).not.toHaveBeenCalled();
});

it('holds PTY buffered input until it is accepted and requires fresh quiet polls', () => {
  const f = fixture();
  const session = { alive: true, roomId: 'alice', journalConvoId: 'alice', iv: {}, _awaitingInputReady: true };
  const send = indexFunction('sendToSession', { restartLatch: f.latch, notePreReapTurnStart() {}, AGENT_CODEX: 'codex' });
  expect(send(session, [{ type: 'text', text: 'hello' }])).toBe(true);
  expect(session.busy).toBeUndefined();
  const observe = prev => evaluateQuiet({ sessions: [session], prev,
    readProcessTable: () => ({ ok: true, table: [] }), listRunningSubagents: () => [], bootAt: 0 });
  let observed = observe({ consecutiveQuiet: 2 });
  expect(observed.holders).toContainEqual({ convoId: 'alice', why: 'queued_input' });
  f.deps.quiet = () => observed;
  const latch = createRestartLatch(f.deps);
  const ready = () => latch.onReady({ sha: 'head', state: f.stateStore.getState() });
  expect(ready().latched, 'PTY buffer must suppress restart').toBe(false);
  session._awaitingInputReady = false;
  observed = observe(observed);
  expect(observed.quiet, 'outbox holds until PTY accepts it').toBe(false);
  session._resumeOutbox = null;
  session.busy = true;
  observed = observe(observed);
  expect(observed.quiet, 'accepted input holds through its turn').toBe(false);
  session.busy = false;
  observed = observe(observed);
  expect(ready().latched, 'first quiet poll must not restart').toBe(false);
  observed = observe(observed);
  expect(ready().latched).toBe(true);
});

it('guards every ingress and rejects unknown dispatcher callers', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const nodes = new Map();
  const name = node => node?.type === 'Identifier' ? node.name
    : node?.type === 'MemberExpression' ? `${name(node.object)}.${name(node.property)}`
      : node?.type === 'ChainExpression' ? name(node.expression) : null;
  for (const statement of ast.body) {
    const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (!node) continue;
    if (node.type === 'FunctionDeclaration') nodes.set(node.id.name, node);
    else if (node.type === 'VariableDeclaration') {
      for (const entry of node.declarations) nodes.set(name(entry.id), entry.init);
    } else if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression') {
      nodes.set(name(node.expression.left), node.expression.right);
    }
  }
  const dispatchers = new Set(['sendToSession', 'sendTextToSession', 'journalRouteTextToSession',
    'flushQueue', 'journalMediaRouter', 'roomDelivery.deliver', 'roomDelivery.flush']);
  for (let changed = true; changed;) {
    changed = false;
    for (const [owner, node] of nodes) {
      if (!dispatchers.has(owner) && dispatchers.has(name(node))) { dispatchers.add(owner); changed = true; }
    }
  }
  const callers = new Set([
    'journalRpcHandler', 'flushPendingSessionQueue', 'submitAnswer', 'sendTextToSession',
    'submitCodexAsyncAnswer', 'dispatchMergedFlush', 'runCodexControl', 'journalRouteTextToSession',
    'journalOnText', 'journalMediaRouter', 'itemTurnRouter', 'deliverCoordinatorTurn', 'journalOnMedia',
    'carryOnConvo', 'fireTimer', 'fireAutoResume', 'applyControlSteps', 'restartNotices', 'flushRoomInbox',
    'roomDelivery', 'foreignSessions', 'deliverRoomFrameTo', 'deliverInviteAsk', 'deliverAutoJoinedRequest',
    'journalNotifyRoomEvent', 'approvePlanBuild', 'secretRequests', 'handleWake', 'agentSpawnHandlers',
    'apiServer', 'runPreReapHandoff', 'drainPreReapCompact',
    // Boot-time note hand-off: runs once at startup, before any latch can exist.
    'deliverRestartNote',
  ]);
  const edges = new Map(), guarded = new Set(), unknown = [];
  function walk(node, owner) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier' && nodes.has(node.name)) edges.get(owner).add(node.name);
    if (node.type === 'CallExpression') {
      const callee = name(node.callee);
      if (callee === 'restartLatch.beginInput') guarded.add(owner);
      if (callee?.startsWith('roomDelivery.')) edges.get(owner).add('roomDelivery');
      if (dispatchers.has(callee) && !callers.has(owner)) unknown.push(`${owner} -> ${callee}`);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, owner));
      else if (value && typeof value === 'object') walk(value, owner);
    }
  }
  for (const [owner, node] of nodes) { edges.set(owner, new Set()); walk(node, owner); }
  // Also catch a dispatcher introduced at module scope, outside a registered entry.
  for (const node of ast.body) {
    if (node.type === 'ExpressionStatement' && node.expression.type !== 'AssignmentExpression') {
      edges.set('module', new Set()); walk(node, 'module');
    }
  }
  expect(unknown, 'unknown dispatcher callers need ingress coverage').toEqual([]);
  function reachesGuard(owner, seen = new Set()) {
    if (guarded.has(owner)) return true;
    if (seen.has(owner)) return false;
    seen.add(owner);
    return [...(edges.get(owner) || [])].some(next => reachesGuard(next, seen));
  }
  const ingress = [
    'sendToSession', 'sendTextToSession', 'journalRouteTextToSession', 'journalOnText', 'journalOnMedia',
    'journalMediaRouter', 'fireTimer', 'journalOnRoomFrame', 'deliverRoomFrameTo', 'routeLocalRoomMessage',
    'routeLocalRoomAttachment', 'routeLocalRoomFrame', 'journalInjectInviteRequest', 'deliverInviteAsk',
    'deliverAutoJoinedRequest', 'journalNotifyRoomEvent', 'journalHandleControlCommand', 'journalControlSession',
    'applyControlSteps', 'applyControlEffort', 'drainDeferredControls', 'flushQueue', 'flushPendingSessionQueue',
    'dispatchMergedFlush', 'fireAutoResume', 'carryOnConvo', 'runPreReapHandoff', 'journalResumeConvo',
  ];
  for (const entry of ingress) {
    expect(nodes.has(entry), `missing ingress ${entry}`).toBe(true);
    expect(reachesGuard(entry), `${entry} must reach beginInput`).toBe(true);
  }
  expect(guarded.has('deliverAutoJoinedRequest'), 'auto-join must guard its awaits').toBe(true);
  expect(source).toContain('plannedRestart.retryCleanup = restartLatch.retryCleanup;');
  expect(source).toMatch(/plannedRestart\.retryCleanup\?\.\(\);\s*const state = plannedRestartState/);
  expect(source).toContain('if (plannedRestartAvailable) enterResumeHold(session);');
  const media = fs.readFileSync(new URL('../lib/journal-media.js', import.meta.url), 'utf8');
  expect(media).toContain('try { finishInput = beginInput(); }');
  expect(media).toContain('finishInput: beginInput()');
});

it('persists the restarted process identity with the participant snapshot', () => {
  const f = fixture();
  expect(f.ready().latched).toBe(true);
  expect(f.stateStore.getState().boot_id).toBe('box-a');
});

it('commits a complete restart on the first durable latch write', () => {
  const f = fixture();
  const save = f.stateStore.setState;
  let snapshot;
  f.stateStore.setState = (state, patch) => {
    const result = save(state, patch);
    if (!snapshot) { snapshot = result; throw new Error('interrupted write'); }
    return result;
  };
  f.ready();
  expect(snapshot).toMatchObject({ state: 'restarting', restarting_at: 400000,
    expected_sha: 'head', previous_sha: 'boot', boot_id: 'box-a', participants: ['bob', 'alice'], stamp_written: true });
});

it('keeps restart participants and stamp during the shutdown flush wait', async () => {
  const f = fixture();
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function gracefulShutdown(');
  const body = source.slice(start, source.indexOf("\nprocess.on('SIGINT'", start));
  let release;
  const flush = new Promise(resolve => { release = resolve; });
  const exited = vi.fn();
  const shutdown = runInNewContext(`let shuttingDown = false; ${body}\ngracefulShutdown`, {
    publishBoxStatus() {}, stopCpuSampler() {}, sessions: new Map(), killSession() {}, powerHold: { stop() {} },
    journalPublisher: { flush: () => flush }, FLUSH_TIMEOUT_MS: 2000, process: { exit: exited }, console,
  });
  let pending;
  const latch = createRestartLatch({ ...f.deps, gracefulShutdown: (...args) => { pending = shutdown(...args); } });
  expect(latch.onReady({ sha: 'head', state: f.stateStore.getState() }).latched).toBe(true);
  const before = f.stateStore.getState();
  const finish = latch.beginInput(); finish();
  expect(f.stateStore.getState()).toEqual(before);
  expect(fs.existsSync(f.stamp)).toBe(true);
  expect(latch.beforeRequest()).toBe(true);
  expect(exited).not.toHaveBeenCalled();
  release(); await pending;
  expect(exited).toHaveBeenCalledWith(75);
});

it.each(['acceptance', 'backlog', 'context'])('holds the latch while auto-join awaits %s', async dependency => {
  const f = fixture();
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function deliverAutoJoinedRequest(');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  let release, reached;
  const waiting = new Promise(resolve => { release = resolve; });
  const blocked = new Promise(resolve => { reached = resolve; });
  const wait = async name => { if (dependency === name) { reached(); await waiting; } };
  const delivered = vi.fn();
  const handler = runInNewContext(`${body}\ndeliverAutoJoinedRequest`, {
    restartLatch: f.latch,
    agentInvites: { answerAwait: async () => { await wait('acceptance'); return { kind: 'answered' }; } },
    agentRooms: { setState() {} }, publishInviteRequestNotice() {},
    journalPublisher: { fetchMessages: async () => { await wait('backlog'); return { events: [] }; } },
    foreignSessions: { refreshContext: async () => { await wait('context'); } },
    roomDelivery: { deliver: delivered }, formatAutoJoinedRequest: () => 'continue',
  });
  const pending = handler({ roomId: 'alice' }, { room_id: 'bob', person: { name: 'alice' } }, {}, { addressed: true });
  await blocked;
  expect(f.ready().latched).toBe(false);
  expect(f.shutdown).not.toHaveBeenCalled();
  release(); await pending;
  expect(delivered).toHaveBeenCalledOnce();
  expect(f.ready().latched).toBe(true);
});
