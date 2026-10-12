import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSubagentRunningStore } from '../lib/subagent-running-store.js';
import { runInNewContext } from 'node:vm';
import { selectStrandedChildren, strandedRepairFrames } from '../lib/subagent-reconcile.js';
import { childConvoId, createSubagentConvoTracker } from '../lib/subagent-convos.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoomDelivery } from '../lib/room-delivery.js';
import { evaluateQuiet } from '../lib/restart-quiet.js';
import { readProcessTableStrict, processTableCommand, parseProcessIdentities } from '../lib/process-table.js';

const exec = vi.fn();
const strictRead = () => readProcessTableStrict({ exec });

const parent = { alive: true, roomId: 'room', journalConvoId: 'parent', proc: { pid: 100 } };
const child = { pid: 101, ppid: 100, args: 'rake test' };
const running = { parentConvoId: 'parent', childConvoId: 'child', addedAt: 1000 };
const poll = (overrides = {}) => evaluateQuiet({
  sessions: new Map([['room', parent]]),
  readProcessTable: () => ({ ok: true, table: [] }),
  listRunningSubagents: () => [],
  bootAt: 1000,
  mcpSignatures: [],
  prev: { consecutiveQuiet: 2 },
  ...overrides,
});
const held = (result, why) => {
  expect(result.quiet, `expected quiet=false with holder {why:'${why}'}`).toBe(false);
  expect(result.holders).toContainEqual({ convoId: 'parent', why });
  expect(result.consecutiveQuiet).toBe(0);
};
const open = (result, count) => expect(result).toEqual({
  quiet: count >= 2, holders: [], probe_error: null, consecutiveQuiet: count,
});

describe('evaluateQuiet', () => {
  it.each([1000, 1001])('ignores pre-boot children after lazy resume and holds children added at %s', (addedAt) => {
    const session = { ...parent, alive: false };
    const options = { sessions: [session], listRunningSubagents: () => [{ ...running, addedAt: 999 }] };
    session.alive = true;
    open(poll(options), 3);
    held(poll({ ...options, listRunningSubagents: () => [{ ...running, addedAt }] }), 'subagents');
  });

  it('property: only children added since boot hold a resumed parent', () => {
    for (let offset = -20; offset <= 20; offset++) {
      const result = poll({ listRunningSubagents: () => [{ ...running, addedAt: 1000 + offset }] });
      expect(result.quiet, `offset ${offset}`).toBe(offset < 0);
      expect(result.holders.length).toBe(offset < 0 ? 0 : 1);
    }
  });

  it.each([null, undefined, '999', NaN, Infinity, -1])('fails closed on an unknown child timestamp %s', (addedAt) => {
    const result = poll({ listRunningSubagents: () => [{ ...running, addedAt }] });
    expect(result.probe_error).toBe('subagents');
    expect(result.quiet).toBe(false);
    expect(result.consecutiveQuiet).toBe(0);
  });

  it.each([undefined, null, NaN, Infinity, -1])('fails closed on an invalid boot timestamp %s', (bootAt) => {
    const result = poll({ bootAt });
    expect(result.probe_error).toBe('subagents');
    expect(result.quiet).toBe(false);
  });

  it('holds a running subagent of this parent', () => held(poll({ listRunningSubagents: () => [running] }), 'subagents'));

  it.each([
    ['print', { proc: { pid: 100 }, busy: true }],
    ['PTY', { iv: { pty: { pid: 100 } }, busy: true }],
    ['Codex', { codex: { child: { pid: 100 } }, busy: true }],
    ['permission', { waitingForAnswer: true }],
    ['consent', { pendingInteractivePrompt: { kind: 'consent' } }],
  ])('holds busy %s sessions', (_mode, fields) => held(poll({ sessions: [{ ...parent, ...fields }] }), 'busy'));

  it('holds an unclassified prompt until answered and needs two quiet polls', () => {
    const session = { ...parent, busy: false, pendingUnclassifiedPrompt: true };
    const blocked = poll({ sessions: [session] });
    held(blocked, 'busy');
    session.pendingUnclassifiedPrompt = false;
    const first = poll({ sessions: [session], prev: blocked });
    open(first, 1);
    open(poll({ sessions: [session], prev: first }), 2);
  });

  it.each([
    ['print', { proc: { pid: 100 } }],
    ['PTY', { proc: null, iv: { pty: { pid: 100 } } }],
    ['Codex', { proc: null, codex: { child: { pid: 100 } } }],
  ])('holds work descendants for %s', (_mode, fields) => held(poll({
    sessions: [{ ...parent, ...fields }],
    readProcessTable: () => ({ ok: true, table: [child, { pid: 102, ppid: 101, args: 'ruby' }] }),
  }), 'children'));

  it.each([8 * 3600 * 1000, 8 * 3600 * 1000 + 1])('has no work cap at %s ms', (age) => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const options = { sessions: [{ ...parent, lastActivityAt: now - age }], readProcessTable: () => ({ ok: true, table: [child] }) };
      const blocked = poll(options);
      held(blocked, 'children');
      const first = poll({ ...options, readProcessTable: () => ({ ok: true, table: [] }), prev: blocked });
      open(first, 1);
      open(poll({ ...options, readProcessTable: () => ({ ok: true, table: [] }), prev: first }), 2);
    } finally {
      clock.mockRestore();
    }
  });

  it('requires one versus two quiet polls', () => {
    const first = poll({ prev: undefined });
    open(first, 1);
    open(poll({ prev: first }), 2);
  });

  it.each([
    ['ok:false', () => ({ ok: false })],
    ['throw', () => { throw new Error('unreadable'); }],
    ['timeout', () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }],
    ['missing', undefined],
    ['null', () => null],
    ['missing table', () => ({ ok: true })],
    ['non-array table', () => ({ ok: true, table: {} })],
  ])('fails closed on table read %s and needs two recovery polls', (_kind, readProcessTable) => {
    const failed = poll({ readProcessTable });
    expect(failed.quiet).toBe(false);
    expect(failed.probe_error).toBe('process_table');
    expect(failed.consecutiveQuiet).toBe(0);
    const first = poll({ prev: failed });
    open(first, 1);
    open(poll({ prev: first }), 2);
  });

  it.each([
    ['throw', () => { throw new Error('unreadable'); }],
    ['missing', undefined],
    ['null', () => null],
  ])('fails closed on subagent read %s', (_kind, listRunningSubagents) => {
    const failed = poll({ listRunningSubagents });
    expect(failed.quiet).toBe(false);
    expect(failed.probe_error).toBe('subagents');
    expect(failed.consecutiveQuiet).toBe(0);
  });

  it.each(['queuedMessages', '_deferredControls'])('holds %s input', (field) => held(poll({
    sessions: [{ ...parent, [field]: field === 'queuedMessages' ? ['hello'] : { compact: { kind: 'compact' } } }],
  }), 'queued_input'));

  it('excludes only restart_notice controls', () => {
    open(poll({ sessions: [{ ...parent, _deferredControls: { restart_notice: { kind: 'restart_notice' } } }] }), 3);
    held(poll({ sessions: [{ ...parent, _deferredControls: { restart_notice: {}, alert: {} } }] }), 'queued_input');
  });

  it('ignores reaped sessions with every holder', () => open(poll({
    sessions: [null, { ...parent, alive: false, busy: true, queuedMessages: ['hello'], _deferredControls: { compact: {} } }],
    readProcessTable: () => ({ ok: true, table: [child] }), listRunningSubagents: () => [running],
  }), 3));

  it('does not hold unrelated subagents or configured MCP subtrees', () => open(poll({
    listRunningSubagents: () => [{ ...running, parentConvoId: 'other' }],
    mcpSignatures: [['server.js']],
    readProcessTable: () => ({ ok: true, table: [{ ...child, args: 'node server.js' }, { pid: 102, ppid: 101, args: 'browser' }] }),
  }), 3));

  it('uses the native conversation ID when no journal ID is assigned', () => held(poll({
    sessions: [{ ...parent, journalConvoId: null, claudeSessionId: 'parent' }], listRunningSubagents: () => [running],
  }), 'subagents'));

  it('property: quiet implies no alive session holds (exhaustive combinations)', () => {
    for (let i = 0; i < 128; i++) {
      const bits = (i + 3) % 128;
      const alive = !!(bits & 1), busy = !!(bits & 2), children = !!(bits & 4), subagents = !!(bits & 8);
      const queued = !!(bits & 16), control = !!(bits & 32), notice = !!(bits & 64);
      const result = poll({
        sessions: [{ ...parent, alive, busy, queuedMessages: queued ? ['hello'] : [],
          _deferredControls: { ...(control ? { compact: {} } : {}), ...(notice ? { restart_notice: {} } : {}) } }],
        readProcessTable: () => ({ ok: true, table: children ? [child] : [] }),
        listRunningSubagents: () => subagents ? [running] : [],
      });
      expect(result.quiet, `combination ${bits}`).toBe(!(alive && (busy || children || subagents || queued || control)));
      expect(Array.isArray(result.holders)).toBe(true);
      expect(result.holders.length > 0).toBe(alive && (busy || children || subagents || queued || control));
    }
  });
});

describe('readProcessTableStrict', () => {
  beforeEach(() => { exec.mockReset(); });

  it('parses a successful observation with bounded scrubbed execution', () => {
    exec.mockReturnValue(process.platform === 'win32'
      ? '100 1 2026-01-01T00:00:00Z claude\n101 100 2026-01-01T00:00:00Z rake test\n'
      : '100 1 100 100 Thu Jan 1 00:00:00 2026 claude\n101 100 100 100 Thu Jan 1 00:00:00 2026 rake test\n');
    const startTime = process.platform === 'win32' ? '2026-01-01T00:00:00Z' : 'Thu Jan 1 00:00:00 2026';
    const group = process.platform === 'win32' ? {} : { pgid: 100, sid: 100 };
    expect(strictRead()).toEqual({ ok: true, table: [{ ...group, pid: 100, ppid: 1, args: 'claude', startTime }, { ...child, ...group, startTime }] });
    const { file, args } = processTableCommand(process.platform, true);
    expect(exec).toHaveBeenCalledWith(file, args, expect.objectContaining({
      encoding: 'utf8', timeout: process.platform === 'win32' ? 15000 : 5000,
      maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    }));
    const env = exec.mock.calls[0][2].env;
    for (const key of ['JOURNAL_TOKEN', 'JOURNAL_TOKEN_FILE', 'HMAC_SECRET', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) expect(env).not.toHaveProperty(key);
  });

  it('preserves opaque POSIX session identities', () => {
    const output = '100 1 100 abcd Thu Jan 1 00:00:00 2026 claude\n';
    expect(() => parseProcessIdentities(output, 'darwin')).not.toThrow();
    expect(parseProcessIdentities(output, 'darwin')[0]).toMatchObject({ pid: 100, pgid: 100, sid: 'abcd' });
  });

  it.each(['ENOENT', 'EACCES', 'ETIMEDOUT'])('returns ok:false on %s', (code) => {
    exec.mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    expect(strictRead()).toEqual({ ok: false });
  });

  it('distinguishes a successful empty table from failure', () => {
    exec.mockReturnValue('');
    expect(strictRead()).toEqual({ ok: true, table: [] });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

// Execute the bridge's actual repair entry point with fake journal/store resources.
describe('boot subagent reconciliation', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = index.indexOf('function reconcileStrandedSubagents(');
  const fn = index.slice(start, index.indexOf('\n}\n', start) + 3);
  const old = { childConvoId: childConvoId('alice', 'bob'), parentConvoId: 'alice', agentId: 'bob', addedAt: 999 };
  const current = { childConvoId: childConvoId('alice', 'box-a'), parentConvoId: 'alice', agentId: 'box-a', addedAt: 1000 };
  function repair({ entries = [old, current], live = true, send = 'pending', readError = null, store } = {}) {
    const remove = vi.fn(), warn = vi.fn(), frames = [];
    const context = {
      JOURNAL_ENABLED: true, BRIDGE_BOOT_AT: 1000,
      sessions: new Map([['alice', { alive: live, journalConvoId: 'alice' }]]),
      journalConvoIdFor: (session) => session.journalConvoId,
      subagentRunningStore: store || { listStrict: () => { if (readError) throw readError; return { ok: true, records: entries }; }, remove },
      selectStrandedChildren, strandedRepairFrames,
      journalPublisher: { upsertConvoBestEffort: (id, fields, callbacks) => {
        if (send === 'throw') throw new Error('unavailable');
        frames.push({ id, fields, callbacks });
        if (send === 'delivered') callbacks.onLocalSendComplete();
        return send !== 'rejected';
      } },
      console: { warn, log() {} },
    };
    runInNewContext(`${fn}\nreconcileStrandedSubagents('startup', { beforeBootOnly: true });`, context);
    return { remove, warn, frames, context };
  }

  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'restart-children-')); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  const strictRecords = (store) => {
    const result = store.listStrict();
    if (!result.ok) throw new Error('unavailable');
    return result.records;
  };
  const gate = (store, bootAt = 1000) => poll({
    sessions: [{ alive: true, journalConvoId: 'alice' }],
    bootAt, listRunningSubagents: () => strictRecords(store),
  });

  it.each(['discover', 'revive'])('holds a resumed incarnation after %s and fences an old repair delivery', (method) => {
    const file = path.join(dir, 'running.json');
    writeFileSync(file, JSON.stringify({ [old.childConvoId]: old }));
    const store = createSubagentRunningStore({ file, bootAt: 1000, log: { warn() {} } });
    const tracker = createSubagentConvoTracker({
      runningStore: store, getParentConvoId: () => 'alice',
      publisher: { upsertConvo() {}, publishStatus() {} },
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(999);
    if (method === 'revive') {
      tracker.discover('bob');
      tracker.finishAll();
    }
    const h = repair({ store });
    expect(h.frames).toHaveLength(1);
    expect(gate(store).quiet).toBe(true);
    clock.mockReturnValue(1001);
    tracker[method]('bob');
    expect(strictRecords(store)[0].addedAt).toBe(1001);
    expect(gate(store).quiet).toBe(false);
    expect(gate(store).holders).toContainEqual({ convoId: 'alice', why: 'subagents' });
    h.frames[0].callbacks.onLocalSendComplete();
    expect(strictRecords(store)).toEqual([{ ...old, addedAt: 1001 }]);
    expect(gate(store).quiet).toBe(false);
  });

  it('keeps corrupt state unknown after boot reconciliation', () => {
    const file = path.join(dir, 'running.json');
    writeFileSync(file, '{invalid');
    const store = createSubagentRunningStore({ file, log: { warn() {} } });
    const h = repair({ store });
    expect(h.frames).toEqual([]);
    const result = gate(store);
    expect(result.probe_error).toBe('subagents');
    expect(result.quiet).toBe(false);
    expect(result.consecutiveQuiet).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('{invalid');
  });

  it('initializes the production boot timestamp before current work and holds that work', async () => {
    vi.resetModules();
    const { BRIDGE_BOOT_AT } = await import('../lib/boot-time.js');
    expect(BRIDGE_BOOT_AT).toBeLessThanOrEqual(Date.now());
    expect(index).toContain("import { BRIDGE_BOOT_AT } from './lib/boot-time.js';");
    const store = createSubagentRunningStore({ file: path.join(dir, 'running.json') });
    store.add(old.childConvoId, { parentConvoId: 'alice', agentId: 'bob' });
    const result = gate(store, BRIDGE_BOOT_AT);
    expect(result.quiet).toBe(false);
    expect(result.holders).toContainEqual({ convoId: 'alice', why: 'subagents' });
  });

  it.each([true, false])('repairs only pre-boot children with parent live=%s', (live) => {
    const main = index.slice(index.indexOf('async function main()'));
    const restart = main.indexOf('restartBoot?.reconcile();');
    const subagents = main.indexOf("reconcileStrandedSubagents('startup', { beforeBootOnly: true });");
    expect(restart).toBeGreaterThan(-1);
    expect(subagents).toBeGreaterThan(restart);
    expect(main.indexOf('timerStore.init()')).toBeGreaterThan(subagents);
    expect(main.indexOf('await ')).toBeGreaterThan(subagents);
    const h = repair({ live, send: 'delivered' });
    expect(h.frames.map((frame) => frame.id)).toEqual([old.childConvoId]);
    expect(h.frames[0].fields).toEqual({ sessionState: 'done', parentConvoId: 'alice' });
    expect(h.remove.mock.calls).toEqual([[old.childConvoId]]);
  });

  it.each(['pending', 'rejected'])('retains recovery records until local send completion: %s', (send) => {
    const h = repair({ send });
    expect(h.frames.map((frame) => frame.id)).toEqual([old.childConvoId]);
    expect(h.remove).not.toHaveBeenCalled();
    h.frames[0].callbacks.onLocalSendComplete();
    expect(h.remove).toHaveBeenCalledWith(old.childConvoId);
  });

  it.each(['throw', 'read error', 'malformed'])('refuses unsafe removal on %s', (kind) => {
    const h = repair({ send: kind === 'throw' ? 'throw' : 'delivered',
      readError: kind === 'read error' ? new Error('unreadable') : null,
      entries: kind === 'malformed' ? [{ ...old, parentConvoId: 'bob' }] : [old] });
    expect(h.warn).toHaveBeenCalled();
    expect(h.frames).toEqual([]);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('retries pre-boot repairs on reconnect even with a resumed parent', () => {
    const h = repair();
    expect(h.frames.map((frame) => frame.id)).toEqual([old.childConvoId]);
    h.frames.length = 0;
    runInNewContext(`${fn}\nreconcileStrandedSubagents('reconnect');`, h.context);
    expect(h.frames.map((frame) => frame.id)).toEqual([old.childConvoId]);
    expect(h.remove).not.toHaveBeenCalled();
  });
});

it.each(['_resumeOutbox', '_awaitingInputReady'])('holds PTY input before acceptance: %s', field => held(poll({
  sessions: [{ ...parent, [field]: field === '_resumeOutbox' ? ['hello'] : true }],
}), 'queued_input'));

// The fork's peer inbox is independent of session.queuedMessages. A pending
// delivery must survive the seam where busy clears before its inbox drains.
it.each(['roomDelivery', 'peerDelivery'])('holds the fork %s inbox until delivery', inbox => {
  const session = { ...parent, busy: true };
  const inject = vi.fn(() => true);
  const delivery = createRoomDelivery({ isBusy: target => target.busy, injectTurn: inject });
  delivery.deliver(session, session.roomId, { from: 'alice', body: 'Continue', roomId: 'room' });
  session.busy = false;
  const options = { sessions: [session], hasQueuedInput: target => delivery.pendingCount(target.roomId) > 0 };
  held(poll(options), 'queued_input');
  expect(inject).not.toHaveBeenCalled();
  expect(delivery.flush(session, session.roomId)).toBe(true);
  open(poll({ ...options, prev: { consecutiveQuiet: 0 } }), 1);
  open(poll({ ...options, prev: { consecutiveQuiet: 1 } }), 2);
  expect(inject).toHaveBeenCalledOnce();
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  expect(source).toContain(`${inbox}.pendingCount(session.roomId) > 0`);
});
