import { describe, it, expect } from 'vitest';
import { createPlanApprovalItems, formatPlanItemBody, PLAN_BODY_MAX } from '../lib/plan-approval-items.js';

// Item #2317 (Dan, 2026-09-22): a plan waiting for "build" is a consent card
// that can sit for hours, so it is mirrored into the tracker like a spawn ask
// or a secret request, and closed by whatever settles it. Everything I/O
// shaped is injected: the items client, the convo lookup, persistence.

function makeItems() {
  const calls = { create: [], close: [] };
  let n = 40;
  return {
    calls,
    create: async (body, opts) => {
      calls.create.push({ body, opts });
      n += 1;
      return { status: 201, data: { item: { id: `it_${n}`, num: n } } };
    },
    close: async (id, body) => { calls.close.push({ id, body }); return { status: 200, data: {} }; },
  };
}

function makeStore() {
  const persisted = [];
  const items = makeItems();
  const store = createPlanApprovalItems({
    items,
    journalConvoIdFor: (session) => session.convoId ?? null,
    persist: (session, planItemId, planToolUseId) => persisted.push({ roomId: session.roomId, planItemId, ...(planToolUseId !== undefined ? { planToolUseId } : {}) }),
    log: { warn() {} },
  });
  return { items, store, persisted };
}

const PLAN = '# Plan\n\n1. Add the column\n2. Write the test';

describe('formatPlanItemBody', () => {
  it('carries the plan as markdown and says how to answer, from the item or the conversation', () => {
    const body = formatPlanItemBody({ plan: PLAN });
    expect(body).toContain(PLAN);
    expect(body).toMatch(/reply\s+`build`/i);
    expect(body).toMatch(/feedback/i);
  });
  it('caps a very long plan and says so', () => {
    const body = formatPlanItemBody({ plan: 'x'.repeat(PLAN_BODY_MAX + 500) });
    expect(body.length).toBeLessThan(PLAN_BODY_MAX + 400);
    expect(body).toMatch(/truncated/i);
  });
});

describe('opened', () => {
  it('files a question on the session conversation, awaiting the user, and remembers the item on the session', async () => {
    const { items, store, persisted } = makeStore();
    const session = { roomId: 'r1', convoId: 'c1' };
    const num = await store.opened(session, PLAN);
    expect(num).toBe(41);
    expect(items.calls.create).toHaveLength(1);
    const { body, opts } = items.calls.create[0];
    expect(body.kind).toBe('question');
    expect(body.convo_id).toBe('c1');
    expect(body.title).toMatch(/plan ready/i);
    expect(body.labels).toEqual(['plan']);
    expect(body.body).toContain(PLAN);
    expect(opts?.idemKey).toBeTruthy();
    expect(session.planItemId).toBe('it_41');
    expect(persisted.at(-1)).toMatchObject({ roomId: 'r1', planItemId: 'it_41' });
  });

  it('a newer plan supersedes the open one: the old item closes as cancelled first', async () => {
    const { items, store } = makeStore();
    const session = { roomId: 'r1', convoId: 'c1' };
    await store.opened(session, PLAN);
    await store.opened(session, PLAN + '\n3. Again');
    expect(items.calls.close).toEqual([{ id: 'it_41', body: { resolution: 'cancelled', comment: expect.stringMatching(/newer plan/i) } }]);
    expect(session.planItemId).toBe('it_42');
  });

  it('without a journal conversation, or when the journal refuses, nothing is filed and nothing throws', async () => {
    const { items, store } = makeStore();
    expect(await store.opened({ roomId: 'r1', convoId: null }, PLAN)).toBeNull();
    expect(items.calls.create).toHaveLength(0);
    items.create = async () => { throw new Error('boom'); };
    const session = { roomId: 'r1', convoId: 'c1' };
    expect(await store.opened(session, PLAN)).toBeNull();
    expect(session.planItemId).toBeFalsy();
  });
});

describe('resolved', () => {
  it('build closes the item as decided; timeout closes it as cancelled; both forget the item', async () => {
    const { items, store, persisted } = makeStore();
    const s1 = { roomId: 'r1', convoId: 'c1' };
    await store.opened(s1, PLAN);
    await store.resolved(s1, 'build');
    expect(items.calls.close.at(-1)).toEqual({ id: 'it_41', body: { resolution: 'decided', comment: expect.stringMatching(/approved/i) } });
    expect(s1.planItemId).toBeNull();
    expect(persisted.at(-1)).toMatchObject({ roomId: 'r1', planItemId: null });
    const s2 = { roomId: 'r2', convoId: 'c2' };
    await store.opened(s2, PLAN);
    await store.resolved(s2, 'timeout');
    expect(items.calls.close.at(-1)).toEqual({ id: 'it_42', body: { resolution: 'cancelled', comment: expect.stringMatching(/approval window closed/i) } });
  });

  it('is a no-op with nothing open, and swallows a journal failure', async () => {
    const { items, store } = makeStore();
    const session = { roomId: 'r1', convoId: 'c1' };
    await store.resolved(session, 'build');
    expect(items.calls.close).toHaveLength(0);
    await store.opened(session, PLAN);
    items.close = async () => { throw new Error('boom'); };
    await expect(store.resolved(session, 'build')).resolves.toBeUndefined();
    expect(session.planItemId).toBeNull();
  });
});

describe('isBuildReply', () => {
  it("is true only for the user's own 'build' comment on this session's open plan item", () => {
    const { store } = makeStore();
    const session = { roomId: 'r1', convoId: 'c1', planItemId: 'it_41' };
    const marker = (over) => ({ item_id: 'it_41', action: 'commented', by: 'user', comment: { body: ' Build ' }, ...over });
    expect(store.isBuildReply(session, marker())).toBe(true);
    expect(store.isBuildReply(session, marker({ item_id: 'it_99' }))).toBe(false);
    expect(store.isBuildReply(session, marker({ by: 'agent' }))).toBe(false);
    expect(store.isBuildReply(session, marker({ action: 'closed' }))).toBe(false);
    expect(store.isBuildReply(session, marker({ comment: { body: 'build it later' } }))).toBe(false);
    expect(store.isBuildReply({ ...session, planItemId: null }, marker())).toBe(false);
    expect(store.isBuildReply(session, null)).toBe(false);
  });
});

// --- Review round: the item is tied to the hook's tool_use_id ---------------

describe('ownership by tool_use_id', () => {
  it('opened records the hook id and keys idempotency on it; a resolve for another hook is a no-op', async () => {
    const { items, store, persisted } = makeStore();
    const session = { roomId: 'r1', convoId: 'c1' };
    await store.opened(session, PLAN, { toolUseId: 'tu_A' });
    expect(items.calls.create[0].opts.idemKey).toBe('plan:r1:tu_A');
    expect(session.planToolUseId).toBe('tu_A');
    expect(persisted.at(-1)).toEqual({ roomId: 'r1', planItemId: 'it_41', planToolUseId: 'tu_A' });
    await store.resolved(session, 'timeout', { toolUseId: 'tu_STALE' });
    expect(items.calls.close).toHaveLength(0);
    expect(session.planItemId).toBe('it_41');
    await store.resolved(session, 'timeout', { toolUseId: 'tu_A' });
    expect(items.calls.close).toHaveLength(1);
    expect(session.planItemId).toBeNull();
    expect(session.planToolUseId).toBeNull();
  });

  it('a resolve that lands while the create is still in flight closes the fresh item instead of remembering it', async () => {
    const { items, store } = makeStore();
    let release;
    const gate = new Promise((r) => { release = r; });
    const realCreate = items.create;
    items.create = async (...args) => { await gate; return realCreate(...args); };
    const session = { roomId: 'r1', convoId: 'c1' };
    const opening = store.opened(session, PLAN, { toolUseId: 'tu_A' });
    await store.resolved(session, 'build', { toolUseId: 'tu_A' });
    release();
    await opening;
    expect(session.planItemId).toBeNull();
    expect(items.calls.close).toEqual([{ id: 'it_41', body: { resolution: 'cancelled', comment: expect.stringMatching(/settled/i) } }]);
  });
});

describe('reconcileRestored', () => {
  it('closes a restored item whose plan cannot be built any more (iv-mode: the hook died with the process)', async () => {
    const { items, store } = makeStore();
    const session = { roomId: 'r1', convoId: 'c1', planItemId: 'it_9', planToolUseId: 'tu_A', pendingPlanDenialId: null };
    await store.reconcileRestored(session);
    expect(items.calls.close).toEqual([{ id: 'it_9', body: { resolution: 'cancelled', comment: expect.stringMatching(/restart/i) } }]);
    expect(session.planItemId).toBeNull();
  });
  it('keeps a restored item whose plan can still be built (print-mode: the denial id came back with it)', async () => {
    const { items, store } = makeStore();
    const session = { roomId: 'r1', convoId: 'c1', planItemId: 'it_9', planToolUseId: 'tu_A', pendingPlanDenialId: 'tu_A' };
    await store.reconcileRestored(session);
    expect(items.calls.close).toHaveLength(0);
    expect(session.planItemId).toBe('it_9');
  });
});

describe('consumedReply', () => {
  it('a build comment that approved the plan is remembered, so a replay of it is not a turn either', () => {
    const { store } = makeStore();
    const session = { roomId: 'r1', convoId: 'c1', planItemId: 'it_41', planToolUseId: 'tu_A' };
    const marker = { item_id: 'it_41', action: 'commented', by: 'user', comment: { id: 'ic_1', body: 'build' } };
    expect(store.consumedReply(marker)).toBe(false);
    expect(store.isBuildReply(session, marker)).toBe(true);
    expect(store.consumedReply(marker)).toBe(true);
    expect(store.consumedReply({ ...marker, comment: { id: 'ic_2', body: 'build' } })).toBe(false);
  });
});

describe('formatPlanItemBody, review round', () => {
  it('puts how-to-answer before the plan, and closes a fence the cut left open', () => {
    const plan = '```\n' + 'x'.repeat(PLAN_BODY_MAX + 10) + '\n```';
    const body = formatPlanItemBody({ plan });
    expect(body.indexOf('reply `build`')).toBeLessThan(body.indexOf('xxxx'));
    const fences = (body.match(/```/g) || []).length;
    expect(fences % 2).toBe(0);
    expect(body).toMatch(/truncated/i);
  });
});

describe('same hook twice', () => {
  it('a second opened for the same hook keeps the item it already has: no close, no second create', async () => {
    const { items, store } = makeStore();
    const session = { roomId: 'r1', convoId: 'c1' };
    await store.opened(session, PLAN, { toolUseId: 'tu_A' });
    const again = await store.opened(session, PLAN, { toolUseId: 'tu_A' });
    expect(again).toBe(41);
    expect(items.calls.create).toHaveLength(1);
    expect(items.calls.close).toHaveLength(0);
    expect(session.planItemId).toBe('it_41');
    expect(session.planToolUseId).toBe('tu_A');
  });
});
