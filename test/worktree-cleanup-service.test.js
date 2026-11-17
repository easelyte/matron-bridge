import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorktreeLedger } from '../lib/worktree-ledger.js';
import {
  DISCARD_ITEM_LABEL, DISCARD_LABEL, createCleanupService, discardQuestion, verifyDiscardTap,
} from '../lib/worktree-cleanup-service.js';
import { createWorktreeService } from '../lib/worktree-service.js';
import { createSizeCache } from '../lib/worktree-size.js';
import { git, makeRepo, roomyStatfs } from './helpers/worktree-repo.js';

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

function harness({ sizes = null, stepUp = null } = {}) {
  const r = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-wtclean-'));
  cleanups.push(() => { r.cleanup(); fs.rmSync(home, { recursive: true, force: true }); });
  const ledger = createWorktreeLedger({ file: path.join(home, 'worktrees.json') });
  const service = createWorktreeService({ ledger, statfs: roomyStatfs });
  const clean = createCleanupService({ ledger, sizes, stepUp });
  return { r, ledger, service, clean, start: (name) => service.start({ workdir: r.repo, name }) };
}
const commit = (dir) => { fs.writeFileSync(path.join(dir, 'w.txt'), 'w\n'); git(dir, 'add', 'w.txt'); git(dir, 'commit', '-m', 'w'); };

describe('archive and delete', () => {
  it('archive removes a clean worktree and prunes it', async () => {
    const h = harness();
    const out = await h.start('a');
    const res = await h.clean.cleanup({ workdir: out.cwd, action: 'archive' });
    expect(res).toMatchObject({ ok: true, removed: true, branchDeleted: true });
    expect(fs.existsSync(out.entry.path)).toBe(false);
    expect(h.ledger.get(out.cwd)).toBe(null);
  });

  it('archive keeps a dirty worktree and files a notice saying what is left', async () => {
    const h = harness();
    const out = await h.start('a');
    commit(out.entry.path);
    fs.writeFileSync(path.join(out.entry.path, 'scratch.txt'), 's\n');
    const res = await h.clean.cleanup({ workdir: out.cwd, action: 'archive' });
    expect(res).toMatchObject({ ok: true, removed: false, kept: true, needsStepUp: true });
    expect(res.notice.title).toMatch(/kept/);
    expect(res.notice.body).toMatch(/1 untracked file/);
    expect(res.notice.body).toMatch(/1 unpushed commit/);
    expect(fs.existsSync(out.entry.path)).toBe(true);
  });

  it('delete reports needs_step_up for lost work, without a notice or a card', async () => {
    const stepUp = { file: vi.fn(), verify: vi.fn() };
    const h = harness({ stepUp });
    const out = await h.start('a');
    fs.writeFileSync(path.join(out.entry.path, 'scratch.txt'), 's\n');
    const asked = await h.clean.cleanup({ workdir: out.cwd, action: 'delete' });
    expect(asked).toMatchObject({ removed: false, needsStepUp: true });
    expect(asked.notice).toBeUndefined();
    expect(stepUp.file).not.toHaveBeenCalled();
    expect(fs.existsSync(out.entry.path)).toBe(true);
  });

  it('refuses while a session still runs in it, and for a folder that is not a worktree', async () => {
    const h = harness();
    const out = await h.start('a');
    expect(await h.clean.cleanup({ workdir: out.cwd, action: 'archive', inUse: () => true })).toMatchObject({ ok: false, code: 'session_active' });
    expect(await h.clean.cleanup({ workdir: h.r.repo, action: 'archive' })).toMatchObject({ ok: false, code: 'not_a_worktree' });
    expect(fs.existsSync(out.entry.path)).toBe(true);
  });

  it('after removal the session cannot be resumed there', async () => {
    const h = harness();
    const out = await h.start('a');
    await h.clean.cleanup({ workdir: out.cwd, action: 'archive' });
    expect(h.service.removedFor(out.cwd)).toMatchObject({ branch: 'wt/a' });
    expect(fs.existsSync(out.entry.path)).toBe(false);
  });
});

describe('discard needs a signed step-up when work would be lost', () => {
  const dirty = async (h) => {
    const out = await h.start('a');
    fs.writeFileSync(path.join(out.entry.path, 'scratch.txt'), 's\n');
    return out;
  };

  it('discard without a verified tap removes nothing, on any box, and files the question', async () => {
    const stepUp = { file: vi.fn(async () => 'item-9'), verify: vi.fn(async () => false), consume: vi.fn() };
    const h = harness({ stepUp });
    const out = await dirty(h);
    const res = await h.clean.cleanup({ workdir: out.cwd, action: 'delete', discard: true, convoId: 'convo-1' });
    expect(res).toMatchObject({ removed: false, kept: true, needsStepUp: true, stepUpItem: 'item-9' });
    expect(stepUp.file).toHaveBeenCalledTimes(1);
    expect(stepUp.file.mock.calls[0][0].subject).toEqual({ op: 'discard_worktree', worktree: out.entry.path, branch: 'wt/a' });
    expect(fs.existsSync(out.entry.path)).toBe(true);
  });

  it('a step_up_item that does not verify is refused and a fresh question is filed', async () => {
    const stepUp = { file: vi.fn(async () => 'item-10'), verify: vi.fn(async () => false), consume: vi.fn() };
    const h = harness({ stepUp });
    const out = await dirty(h);
    const res = await h.clean.cleanup({ workdir: out.cwd, action: 'delete', discard: true, stepUpItem: 'forged' });
    expect(stepUp.verify).toHaveBeenCalledWith('forged', { op: 'discard_worktree', worktree: out.entry.path, branch: 'wt/a' });
    expect(res.removed).toBe(false);
    expect(fs.existsSync(out.entry.path)).toBe(true);
  });

  it('with no step-up wiring at all, discard never removes lost work', async () => {
    const h = harness({ stepUp: null });
    const out = await dirty(h);
    const res = await h.clean.cleanup({ workdir: out.cwd, action: 'delete', discard: true, stepUpItem: 'x' });
    expect(res).toMatchObject({ removed: false, needsStepUp: true });
    expect(fs.existsSync(out.entry.path)).toBe(true);
  });

  it('a verified tap removes the worktree and closes the question', async () => {
    const stepUp = { file: vi.fn(), verify: vi.fn(async () => true), consume: vi.fn(async () => {}) };
    const h = harness({ stepUp });
    const out = await dirty(h);
    const res = await h.clean.cleanup({ workdir: out.cwd, action: 'delete', discard: true, stepUpItem: 'item-ok' });
    expect(res).toMatchObject({ removed: true, discarded: true });
    expect(stepUp.consume).toHaveBeenCalledWith('item-ok');
    expect(fs.existsSync(out.entry.path)).toBe(false);
  });

  it('a clean worktree needs no step-up even with discard set', async () => {
    const stepUp = { file: vi.fn(), verify: vi.fn(), consume: vi.fn() };
    const h = harness({ stepUp });
    const out = await h.start('a');
    const res = await h.clean.cleanup({ workdir: out.cwd, action: 'delete', discard: true });
    expect(res.removed).toBe(true);
    expect(stepUp.verify).not.toHaveBeenCalled();
    expect(stepUp.file).not.toHaveBeenCalled();
  });
});

describe('verifyDiscardTap', () => {
  const subject = { op: 'discard_worktree', worktree: '/r/.claude/worktrees/a', branch: 'wt/a' };
  const item = (over = {}) => ({ step_up: true, state: 'open', labels: [DISCARD_ITEM_LABEL], subject, ...over });
  const tap = (over = {}) => ({ id: 'c1', action: DISCARD_LABEL, approval: { sig: 'x' }, ...over });

  it('accepts a signed Discard tap on our open question for this worktree', async () => {
    expect(await verifyDiscardTap({ item: item(), comments: [tap()] }, subject)).toBe(true);
    expect(await verifyDiscardTap({ item: item(), comments: [{ id: 'c', meta: { action: DISCARD_LABEL }, approval: {} }] }, subject)).toBe(true);
  });
  it('refuses an unsigned tap, another button, another worktree, a closed or unsigned question', async () => {
    expect(await verifyDiscardTap({ item: item(), comments: [tap({ approval: undefined })] }, subject)).toBe(false);
    expect(await verifyDiscardTap({ item: item(), comments: [tap({ action: 'Keep it' })] }, subject)).toBe(false);
    expect(await verifyDiscardTap({ item: item({ subject: { ...subject, worktree: '/other' } }), comments: [tap()] }, subject)).toBe(false);
    expect(await verifyDiscardTap({ item: item({ state: 'closed' }), comments: [tap()] }, subject)).toBe(false);
    expect(await verifyDiscardTap({ item: item({ step_up: false }), comments: [tap()] }, subject)).toBe(false);
    expect(await verifyDiscardTap({ item: item({ labels: [] }), comments: [tap()] }, subject)).toBe(false);
    expect(await verifyDiscardTap({ item: item(), comments: [] }, subject)).toBe(false);
    expect(await verifyDiscardTap(null, subject)).toBe(false);
  });
  it('on a box with pinned keys the box checks the signature itself', async () => {
    const ok = vi.fn(async () => ({ ok: true }));
    const bad = vi.fn(async () => ({ ok: false }));
    const data = { item: item(), comments: [tap()] };
    expect(await verifyDiscardTap(data, subject, { check: ok })).toBe(true);
    expect(await verifyDiscardTap(data, subject, { check: bad })).toBe(false);
    expect(await verifyDiscardTap(data, subject, { check: async () => { throw new Error('x'); } })).toBe(false);
  });
  it('the question is a step-up with the same subject and both buttons', () => {
    const q = discardQuestion({ entry: { path: subject.worktree, branch: 'wt/a' }, blockers: ['1 untracked file'], subject, convoId: 'c' });
    expect(q).toMatchObject({ kind: 'question', step_up: true, subject, labels: [DISCARD_ITEM_LABEL], convo_id: 'c' });
    expect(q.actions).toEqual([DISCARD_LABEL, 'Keep it']);
    expect(q.body).toContain('1 untracked file');
  });
});

describe('picker and box status view', () => {
  it('groups worktrees under their repo with cached sizes, no walk on the request', async () => {
    let measured = 0;
    const sizes = createSizeCache({ measure: async () => { measured += 1; return 1234; } });
    const h = harness({ sizes });
    const out = await h.start('a');
    expect(h.clean.describe()).toEqual([{ path: out.entry.path, repo: h.r.repo, branch: 'wt/a', size_bytes: null }]);
    await sizes.idle();
    expect(h.clean.describe()[0].size_bytes).toBe(1234);
    h.clean.describe(); h.clean.describe();
    expect(measured).toBe(1);
    expect(h.clean.summary()).toEqual({ count: 1, total_bytes: 1234 });
  });

  it('summary is null with no worktrees and omits the total while a size is unknown', async () => {
    const h = harness({ sizes: createSizeCache({ measure: () => new Promise(() => {}) }) });
    expect(h.clean.summary()).toBe(null);
    await h.start('a');
    expect(h.clean.summary()).toEqual({ count: 1 });
  });
});

describe('size cache', () => {
  it('re-measures only after the ttl', async () => {
    let t = 0;
    let n = 0;
    const c = createSizeCache({ ttlMs: 100, now: () => t, measure: async () => ++n });
    expect(c.get('/x')).toBe(null);
    await c.idle();
    expect(c.get('/x')).toBe(1);
    t = 99; c.get('/x'); await c.idle();
    expect(n).toBe(1);
    t = 101; expect(c.get('/x')).toBe(1); await c.idle();
    expect(c.get('/x')).toBe(2);
  });
  it('treats a failing measurement as unknown', async () => {
    const c = createSizeCache({ measure: async () => { throw new Error('x'); } });
    c.get('/x'); await c.idle();
    expect(c.get('/x')).toBe(null);
  });
});
