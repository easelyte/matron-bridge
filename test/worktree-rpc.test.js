import { describe, expect, it, vi } from 'vitest';
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
    defaultWorkdir: '/home/alice',
    defaultAgent: 'claude',
    expandHome: (p) => p,
    statSync: () => ({ isDirectory: () => true }),
    log: silentLog,
    ...overrides,
  });
  return { handler, responses };
}
const settle = () => new Promise((r) => setImmediate(r));

describe('recent_folders and worktrees', () => {
  const records = [
    { workdir: '/repo', lastUsed: 10 },
    { workdir: '/repo/.claude/worktrees/fix-1', lastUsed: 30 },
    { workdir: '/repo/.claude/worktrees/fix-1/pkg', lastUsed: 25 },
  ];

  it('lists them grouped under their repo, with the size the cache has', () => {
    const worktrees = [{ path: '/repo/.claude/worktrees/fix-1', repo: '/repo', branch: 'wt/fix-1', size_bytes: 4096 }];
    const { handler, responses } = harness({ listPersistedSessions: () => records, describeWorktrees: () => worktrees });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.worktrees).toEqual(worktrees);
  });

  it('has no worktrees key when there are none, and survives a failing describe', () => {
    const a = harness();
    a.handler(REQ('recent_folders', {}));
    expect('worktrees' in a.responses[0].result).toBe(false);
    const b = harness({ describeWorktrees: () => { throw new Error('boom'); } });
    b.handler(REQ('recent_folders', {}));
    expect(b.responses[0].ok).toBe(true);
  });

  it('asks for the (cached) worktree view once per request', () => {
    const describeWorktrees = vi.fn(() => []);
    const { handler } = harness({ describeWorktrees });
    handler(REQ('recent_folders', {}));
    expect(describeWorktrees).toHaveBeenCalledTimes(1);
  });
});

describe('worktree_cleanup', () => {
  const rec = { journalConvoId: 'convo-1', workdir: '/repo/.claude/worktrees/fix-1' };
  const ok = (over = {}) => vi.fn(async () => ({ ok: true, removed: true, kept: false, branchDeleted: true, path: rec.workdir, branch: 'wt/fix-1', ...over }));

  it('is unavailable when not wired', () => {
    const { handler, responses } = harness({ listPersistedSessions: () => [rec] });
    handler(REQ('worktree_cleanup', { convo_id: 'convo-1', action: 'archive' }));
    expect(responses[0].error.code).toBe('unsupported_mode');
  });

  it('validates its params', async () => {
    const { handler, responses } = harness({ listPersistedSessions: () => [rec], worktreeCleanup: ok() });
    handler(REQ('worktree_cleanup', { convo_id: 'convo-1', action: 'nuke' }, 'a'));
    handler(REQ('worktree_cleanup', { action: 'archive' }, 'b'));
    handler(REQ('worktree_cleanup', { convo_id: 'nope', action: 'archive' }, 'c'));
    await settle();
    expect(responses.map((r) => r.error.code)).toEqual(['bad_action', 'bad_convo', 'unknown_convo']);
  });

  it('archives the session\'s worktree and reports what happened', async () => {
    const worktreeCleanup = ok();
    const worktreeInUse = () => false;
    const { handler, responses } = harness({ listPersistedSessions: () => [rec], worktreeCleanup, worktreeInUse });
    handler(REQ('worktree_cleanup', { convo_id: 'convo-1', action: 'archive' }));
    await settle();
    expect(worktreeCleanup).toHaveBeenCalledWith({ workdir: rec.workdir, action: 'archive', discard: false, stepUpItem: null, convoId: 'convo-1', inUse: worktreeInUse });
    expect(responses[0]).toMatchObject({ ok: true, result: { removed: true, kept: false, branch_deleted: true, branch: 'wt/fix-1' } });
  });

  it('a kept worktree files the notice and says what is left', async () => {
    const fileWorktreeNotice = vi.fn();
    const worktreeCleanup = ok({ removed: false, kept: true, branchDeleted: false, blockers: ['1 untracked file'], notice: { title: 'Worktree kept: wt/fix-1', body: 'left' } });
    const { handler, responses } = harness({ listPersistedSessions: () => [rec], worktreeCleanup, fileWorktreeNotice });
    handler(REQ('worktree_cleanup', { convo_id: 'convo-1', action: 'archive' }));
    await settle();
    expect(fileWorktreeNotice).toHaveBeenCalledWith({ title: 'Worktree kept: wt/fix-1', body: 'left', convoId: 'convo-1' });
    expect(responses[0].result).toMatchObject({ removed: false, kept: true, left: ['1 untracked file'] });
  });

  it('delete with work at stake says needs_step_up; discard and the signed question go through to the service', async () => {
    const worktreeCleanup = ok({ removed: false, kept: true, blockers: ['x'], needsStepUp: true, stepUpItem: 'item-1' });
    const { handler, responses } = harness({ listPersistedSessions: () => [rec], worktreeCleanup });
    handler(REQ('worktree_cleanup', { convo_id: 'convo-1', action: 'delete' }, 'a'));
    handler(REQ('worktree_cleanup', { convo_id: 'convo-1', action: 'delete', discard: true }, 'b'));
    handler(REQ('worktree_cleanup', { convo_id: 'convo-1', action: 'delete', discard: true, step_up_item: 'item-1' }, 'c'));
    await settle();
    expect(responses[0].result).toMatchObject({ needs_step_up: true, step_up_item: 'item-1' });
    expect(worktreeCleanup.mock.calls[0][0]).toMatchObject({ discard: false, stepUpItem: null });
    expect(worktreeCleanup.mock.calls[1][0]).toMatchObject({ discard: true, stepUpItem: null });
    expect(worktreeCleanup.mock.calls[2][0]).toMatchObject({ discard: true, stepUpItem: 'item-1', convoId: 'convo-1' });
  });

  it('answers refusals from the service with their code', async () => {
    const worktreeCleanup = vi.fn(async () => ({ ok: false, code: 'session_active', detail: 'still running' }));
    const { handler, responses } = harness({ listPersistedSessions: () => [rec], worktreeCleanup });
    handler(REQ('worktree_cleanup', { convo_id: 'convo-1', action: 'archive' }));
    await settle();
    expect(responses[0]).toMatchObject({ ok: false, error: { code: 'session_active', detail: 'still running' } });
  });

  it('is refused while the account is locked', () => {
    const { handler, responses } = harness({ listPersistedSessions: () => [rec], worktreeCleanup: ok(), accountLocked: () => true });
    handler(REQ('worktree_cleanup', { convo_id: 'convo-1', action: 'archive' }));
    expect(responses[0].error.code).toBe('account_locked');
  });
});
