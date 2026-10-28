import { describe, it, expect, vi } from 'vitest';
import { createForeignSessions, ALLOW_LABEL, DECLINE_LABEL, ACTION_TTL_MS } from '../lib/foreign-session.js';
import { actionHash, ACTION_INPUT_MAX, ACTION_PENDING_MAX } from '../lib/foreign-turn.js';

// The stateful half of foreign turns: arming the gate, one-shot approvals,
// the "Allow once" asks and the taps that answer them.
function rig({ busy = false, setThrows = false, stored = {} } = {}) {
  const sent = [];
  const notices = [];
  const flags = new Set();
  const created = [];
  const closed = [];
  let saved = stored;
  const occupied = { v: busy };
  const fs = createForeignSessions({
    sharing: { personRoom: vi.fn(async (roomId) => (roomId === 'room-1'
      ? { status: 200, data: { person_room: { role: 'owner', person: 'tim', room_id: 'room-1', mission: { id: 'mi_1', num: 7, owner: 'alice', title: 'Launch' } } } }
      : { status: 404, data: { error: 'not_found' } })) },
    items: {
      get: async (id) => ({ status: 200, data: { item: { id, mission_id: id === 'it_in' ? 'mi_1' : 'mi_x' } } }),
      create: async (body) => { created.push(body); return { status: 201, data: { item: { id: `it_${created.length}`, num: 100 + created.length } } }; },
      close: async (id, body) => { closed.push([id, body]); return { status: 200, data: {} }; },
    },
    journalConvoIdFor: (s) => `convo-${s.roomId}`,
    sendText: (s, text) => { sent.push([s.roomId, text, !!s.foreignTurn]); return true; },
    publishNotice: (c, t) => notices.push([c, t]),
    isOccupied: () => occupied.v,
    flag: { set: (k) => { if (setThrows) throw new Error('ro'); flags.add(k); }, clear: (k) => flags.delete(k) },
    store: { load: () => saved, save: (o) => { saved = o; } },
  });
  return { fs, sent, notices, flags, created, closed, occupied, saved: () => saved };
}
const session = () => ({ roomId: 'sess-a', alive: true, foreignTurn: null });

describe('arming and disarming', () => {
  it('inject arms the gate before the text goes in, with the banner on top', async () => {
    const r = rig();
    const s = session();
    await r.fs.refreshContext('room-1');
    const turn = r.fs.turnFor('room-1', 'tim', r.fs.cachedContext('room-1'));
    expect(turn).toEqual({ roomId: 'room-1', person: 'tim', role: 'owner', mission: { id: 'mi_1', num: 7, owner: 'alice', title: 'Launch' } });
    expect(r.fs.inject(s, '[room "x"] tim: hi', turn)).toBe(true);
    expect(r.flags.has('sess-a')).toBe(true);
    expect(r.sent[0][2]).toBe(true);
    expect(r.sent[0][1]).toMatch(/^\[Matron: this turn was started by tim/);
    r.fs.end(s);
    expect(s.foreignTurn).toBe(null);
    expect(r.flags.has('sess-a')).toBe(false);
  });
  it('an unknown room gets the narrowest turn: room only, guest role, no mission', async () => {
    const r = rig();
    await r.fs.refreshContext('room-gone');
    expect(r.fs.turnFor('room-gone', 'tim', r.fs.cachedContext('room-gone'))).toEqual({ roomId: 'room-gone', person: 'tim', role: 'guest', mission: null });
  });
  it('a flag that cannot be written means no delivery at all', () => {
    const r = rig({ setThrows: true });
    const s = session();
    expect(r.fs.inject(s, 'x', { roomId: 'room-1', person: 'tim', role: 'owner', mission: null })).toBe(false);
    expect(r.sent).toEqual([]);
    expect(s.foreignTurn).toBe(null);
  });
});

describe('check and the route layer', () => {
  it('denies outside the scope, allows inside', async () => {
    const r = rig();
    const s = session();
    r.fs.begin(s, { roomId: 'room-1', person: 'tim', role: 'owner', mission: { id: 'mi_1', num: 7, owner: 'alice' } });
    expect((await r.fs.check(s, { tool_name: 'Bash', tool_input: { command: 'id' } })).decision).toBe('deny');
    expect((await r.fs.check(s, { tool_name: 'mcp__ask-user__item_get', tool_input: { id: 'it_in' } })).decision).toBe('allow');
    expect((await r.fs.check(s, { tool_name: 'mcp__ask-user__item_get', tool_input: { id: 'it_out' } })).decision).toBe('deny');
    expect(r.fs.routeAllowed(s, '/memory/get', { roomId: 'sess-a' })).toBe(false);
  });
});

describe('Allow once', () => {
  async function asked(r, s) {
    r.fs.begin(s, { roomId: 'room-1', person: 'tim', role: 'owner', mission: null });
    const out = await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: 'git log -3' }, why: 'tim wants the last commits' });
    expect(out.status).toBe(200);
    r.fs.end(s);
    return r.created[0];
  }

  it('is only for a foreign turn', async () => {
    const r = rig();
    expect((await r.fs.requestAction(session(), { tool_name: 'Bash', tool_input: {} })).status).toBe(409);
  });

  it('files an item with the two buttons and keeps the ask across a restart', async () => {
    const r = rig();
    const item = await asked(r, session());
    expect(item).toMatchObject({ kind: 'question', actions: [ALLOW_LABEL, DECLINE_LABEL], convo_id: 'convo-sess-a', awaiting: 'user' });
    // Owner-only: the mission it lands on may well be shared with the very
    // person whose turn asked for it.
    expect(item.private).toBe(true);
    expect(item.body).toContain('"command":"git log -3"');
    expect(Object.keys(r.saved())).toEqual(['it_1']);
    const again = rig({ stored: r.saved() });
    expect(again.fs.pendingCount()).toBe(1);
  });

  it('a tap on Allow once runs a restricted turn in which exactly that call passes, once', async () => {
    const r = rig();
    const s = session();
    await asked(r, s);
    expect(r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: ALLOW_LABEL } })).toBe(true);
    expect(s.foreignTurn).toMatchObject({ person: 'tim' });
    expect(r.sent.at(-1)[1]).toMatch(/allowed ONE call, once: Bash/);
    expect(r.closed[0]).toEqual(['it_1', { resolution: 'answered', comment: 'Allowed once.' }]);
    expect((await r.fs.check(s, { tool_name: 'Bash', tool_input: { command: 'git log -4' } })).decision).toBe('deny');
    expect((await r.fs.check(s, { tool_name: 'Bash', tool_input: { command: 'git log -3' } })).decision).toBe('allow');
    expect((await r.fs.check(s, { tool_name: 'Bash', tool_input: { command: 'git log -3' } })).decision).toBe('deny');
    expect(r.fs.pendingCount()).toBe(0);
  });

  it('an approved bridge-route call gets one pass through the route layer', async () => {
    const r = rig();
    const s = session();
    r.fs.begin(s, { roomId: 'room-1', person: 'tim', role: 'owner', mission: null });
    await r.fs.requestAction(s, { tool_name: 'mcp__ask-user__memory_get', tool_input: { name: 'x' }, why: 'y' });
    r.fs.end(s);
    r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: ALLOW_LABEL } });
    expect(r.fs.routeAllowed(s, '/memory/get', {})).toBe(false);
    expect((await r.fs.check(s, { tool_name: 'mcp__ask-user__memory_get', tool_input: { name: 'x' } })).decision).toBe('allow');
    expect(r.fs.routeAllowed(s, '/memory/get', {})).toBe(true);
    expect(r.fs.routeAllowed(s, '/memory/get', {})).toBe(false);
  });

  it('refuses an input the card could not show in full, rather than cutting it', async () => {
    const r = rig();
    const s = session();
    r.fs.begin(s, { roomId: 'room-1', person: 'tim', role: 'owner', mission: null });
    const out = await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: `echo ok; ${'#'.repeat(ACTION_INPUT_MAX)}` }, why: 'big' });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/too large/);
    expect(r.created).toEqual([]);
    expect(r.fs.pendingCount()).toBe(0);
  });

  it('caps the asks one session may have open', async () => {
    const r = rig();
    const s = session();
    r.fs.begin(s, { roomId: 'room-1', person: 'tim', role: 'owner', mission: null });
    for (let i = 0; i < ACTION_PENDING_MAX; i++) {
      expect((await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: `ls ${i}` }, why: 'y' })).status).toBe(200);
    }
    const out = await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: 'ls more' }, why: 'y' });
    expect(out.status).toBe(429);
    expect(r.created.length).toBe(ACTION_PENDING_MAX);
    // An answer frees a slot.
    r.fs.end(s);
    r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: DECLINE_LABEL } });
    expect((await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: 'ls more' }, why: 'y' })).status).toBe(200);
  });

  it('asks filed in parallel count against the same cap', async () => {
    const r = rig();
    const s = session();
    r.fs.begin(s, { roomId: 'room-1', person: 'tim', role: 'owner', mission: null });
    const outs = await Promise.all(Array.from({ length: ACTION_PENDING_MAX + 3 }, (_, i) =>
      r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: `ls ${i}` }, why: 'y' })));
    expect(outs.filter((o) => o.status === 200).length).toBe(ACTION_PENDING_MAX);
    expect(outs.filter((o) => o.status === 429).length).toBe(3);
    expect(r.created.length).toBe(ACTION_PENDING_MAX);
  });

  it('measures the input in bytes, so multibyte text does not slip past the cap', async () => {
    const r = rig();
    const s = session();
    r.fs.begin(s, { roomId: 'room-1', person: 'tim', role: 'owner', mission: null });
    // Three bytes per character: a third of the cap in characters is over it in bytes.
    const out = await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: '€'.repeat(Math.ceil(ACTION_INPUT_MAX / 3) + 10) }, why: 'y' });
    expect(out.status).toBe(400);
  });

  it('an approved call of a tool that is not a bridge route opens nothing at the route layer', async () => {
    const r = rig();
    const s = session();
    await asked(r, s);
    r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: ALLOW_LABEL } });
    expect((await r.fs.check(s, { tool_name: 'Bash', tool_input: { command: 'git log -3' } })).decision).toBe('allow');
    expect(r.fs.routeAllowed(s, '/memory/get', {})).toBe(false);
    expect(r.fs.routeAllowed(s, '/share-sensitive', {})).toBe(false);
  });

  it('Decline: a restricted turn that says so, and nothing allowed', async () => {
    const r = rig();
    const s = session();
    await asked(r, s);
    r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: DECLINE_LABEL } });
    expect(r.sent.at(-1)[1]).toMatch(/declined/);
    expect((await r.fs.check(s, { tool_name: 'Bash', tool_input: { command: 'git log -3' } })).decision).toBe('deny');
  });

  it('typed prose on the item is an ordinary reply; the ask stays open', async () => {
    const r = rig();
    const s = session();
    await asked(r, s);
    expect(r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { body: 'what is this for?' } })).toBe(false);
    expect(r.fs.pendingCount()).toBe(1);
  });

  it('an item that is not an ask is not ours', () => {
    const r = rig();
    expect(r.fs.onItemReply(session(), { item_id: 'it_other', action: 'commented', comment: { action: ALLOW_LABEL } })).toBe(false);
  });

  it('a tap while the session is busy waits for the next free moment', async () => {
    const r = rig();
    const s = session();
    await asked(r, s);
    r.occupied.v = true;
    const before = r.sent.length;
    r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: ALLOW_LABEL } });
    expect(r.sent.length).toBe(before);
    expect(r.fs.hasParked(s)).toBe(true);
    r.occupied.v = false;
    expect(r.fs.drainParked(s)).toBe(true);
    expect(s.foreignTurn).toMatchObject({ person: 'tim' });
  });

  it('two taps while the session is busy both run, oldest first, one turn each', async () => {
    const r = rig();
    const s = session();
    r.fs.begin(s, { roomId: 'room-1', person: 'tim', role: 'owner', mission: null });
    await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: 'one' }, why: 'a' });
    await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: 'two' }, why: 'b' });
    r.fs.end(s);
    r.occupied.v = true;
    r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: ALLOW_LABEL } });
    r.fs.onItemReply(s, { item_id: 'it_2', action: 'commented', comment: { action: DECLINE_LABEL } });
    r.occupied.v = false;
    const before = r.sent.length;
    expect(r.fs.drainParked(s)).toBe(true);
    expect(r.sent.at(-1)[1]).toMatch(/allowed ONE call, once/);
    expect((await r.fs.check(s, { tool_name: 'Bash', tool_input: { command: 'one' } })).decision).toBe('allow');
    r.fs.end(s);
    expect(r.fs.hasParked(s)).toBe(true);
    expect(r.fs.drainParked(s)).toBe(true);
    expect(r.sent.at(-1)[1]).toMatch(/declined/);
    expect(r.sent.length).toBe(before + 2);
    expect(r.fs.hasParked(s)).toBe(false);
  });

  it('asks older than a week are forgotten', () => {
    const r = rig({ stored: { it_old: { createdAt: Date.now() - ACTION_TTL_MS - 1, hash: actionHash('Bash', {}) } } });
    expect(r.fs.pendingCount()).toBe(0);
  });
});

describe('Codex sessions never take a continuation', () => {
  it('an Allow once tap after a switch to Codex runs nothing and says so', async () => {
    const r = rig();
    const s = session();
    r.fs.begin(s, { roomId: 'room-1', person: 'tim', role: 'owner', mission: null });
    await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: 'git log -3' }, why: 'w' });
    r.fs.end(s);
    const switched = { ...session(), codex: {} };
    expect(r.fs.onItemReply(switched, { item_id: 'it_1', action: 'commented', comment: { action: ALLOW_LABEL } })).toBe(true);
    expect(r.sent).toEqual([]);
    expect(switched.foreignTurn).toBe(null);
    expect(r.closed[0][1].comment).toMatch(/Codex/);
    expect(r.notices.at(-1)[1]).toMatch(/Codex/);
    expect(r.fs.pendingCount()).toBe(0);
  });

  it('parked continuations are dropped, not drained, into a Codex session', async () => {
    const r = rig({ busy: true });
    const s = session();
    r.fs.begin(s, { roomId: 'room-1', person: 'tim', role: 'owner', mission: null });
    await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: 'git log -3' }, why: 'w' });
    r.fs.end(s);
    // Tapped while the Claude session was busy: parked.
    r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: ALLOW_LABEL } });
    expect(r.sent).toEqual([]);
    r.occupied.v = false;
    const switched = { ...session(), codex: {} };
    expect(r.fs.drainParked(switched)).toBe(false);
    expect(r.sent).toEqual([]);
    expect(switched.foreignTurn).toBe(null);
    // And nothing is left to start later.
    expect(r.fs.drainParked(session())).toBe(false);
  });
});
