import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideForeignCall, foreignRouteAllowed, foreignTurnBanner, allowanceTurnText, actionRequestItem } from '../lib/foreign-turn.js';
import { createForeignSessions } from '../lib/foreign-session.js';
import { createJournalInputConsumer } from '../lib/journal-input-router.js';

// Sharing phase 3 across the person boundary: a mission shared with
// contribute access widens the guest side's tracker tools in a foreign turn,
// and another person's comment on a tracker item starts a foreign turn of
// its own, scoped to that item's mission.
const A = 'mcp__ask-user__';
const mission = { id: 'ms_1', num: 7, owner: 'alice', title: 'Fair' };
const guestRead = { roomId: 'room-2', person: 'alice', role: 'guest', mission };
const guestContrib = { ...guestRead, contribute: true };
const owner = { roomId: 'room-1', person: 'bob', role: 'owner', mission: { ...mission, owner: null } };
const itemOwner = { roomId: null, person: 'bob', role: 'owner', mission: { ...mission, owner: null }, item: { id: 'it_5', num: 5 } };
const itemGuest = { roomId: null, person: 'alice', role: 'guest', mission, contribute: true, item: { id: 'it_6', num: 6 } };
const decide = (turn, tool, input, extra = {}) => decideForeignCall({ turn, toolName: `${A}${tool}`, toolInput: input, ...extra });

// Items the lookups know: it_in / their #12 are on the mission, the rest
// are not. sharedBy is how the hook resolves the owner's numbers.
const lookupItem = async (id, sharedBy) => {
  if (sharedBy === 'alice' && id === '#12') return { mission_id: 'ms_1', mission_num: 7 };
  if (id === 'it_in') return { mission_id: 'ms_1', mission_num: 7 };
  return { mission_id: 'ms_other', mission_num: 3 };
};

describe('the guest side of a contribute share', () => {
  it('may post milestones and comment on the shared mission, through shared_by', async () => {
    expect((await decide(guestContrib, 'milestone_post', { kind: 'progress', title: 't', mission: 7, shared_by: 'alice' })).decision).toBe('allow');
    expect((await decide(guestContrib, 'milestone_post', { kind: 'progress', title: 't', mission: 7 })).decision).toBe('deny');
    expect((await decide(guestContrib, 'milestone_post', { kind: 'progress', title: 't', mission: 8, shared_by: 'alice' })).decision).toBe('deny');
    expect((await decide(guestContrib, 'milestone_post', { kind: 'progress', title: 't', mission: 7, shared_by: 'carol' })).decision).toBe('deny');
    expect((await decide(guestContrib, 'item_comment', { id: '#12', body: 'x', shared_by: 'alice' }, { lookupItem })).decision).toBe('allow');
    expect((await decide(guestContrib, 'item_comment', { id: 'it_in', body: 'x' }, { lookupItem })).decision).toBe('allow');
    expect((await decide(guestContrib, 'item_comment', { id: 'it_out', body: 'x' }, { lookupItem })).decision).toBe('deny');
    expect((await decide(guestContrib, 'item_comment', { id: '#12', body: 'x', shared_by: 'carol' }, { lookupItem })).decision).toBe('deny');
  });

  it('an item must carry the turn mission\'s id: a bare mission number never matches', async () => {
    // Another owner's mission can share the number: only the id is proof.
    const numberOnly = async () => ({ mission_num: 7 });
    expect((await decide(guestContrib, 'item_comment', { id: 'it_other', body: 'x', shared_by: 'alice' }, { lookupItem: numberOnly })).decision).toBe('deny');
    expect((await decide(guestContrib, 'item_comment', { id: 'it_other', body: 'x' }, { lookupItem: numberOnly })).decision).toBe('deny');
    expect((await decide(guestRead, 'item_get', { id: 'it_other' }, { lookupItem: numberOnly })).decision).toBe('deny');
  });

  it('still never sends files or buttons, and nothing else opens', async () => {
    expect((await decide(guestContrib, 'item_comment', { id: 'it_in', body: 'x', attachments: ['a.png'] }, { lookupItem })).decision).toBe('deny');
    expect((await decide(guestContrib, 'item_comment', { id: 'it_in', body: 'x', actions: ['Go'] }, { lookupItem })).decision).toBe('deny');
    for (const tool of ['item_create', 'item_close', 'item_reopen', 'mission_status', 'mission_share', 'mission_update']) {
      expect((await decide(guestContrib, tool, { shared_by: 'alice', mission: 7, id: 'it_in' }, { lookupItem })).decision, tool).toBe('deny');
    }
  });

  it('item_get takes no shared_by: one item checked, another read is not possible', async () => {
    expect((await decide(guestContrib, 'item_get', { id: 'it_in' }, { lookupItem })).decision).toBe('allow');
    expect((await decide(guestContrib, 'item_get', { id: '#12', shared_by: 'alice' }, { lookupItem })).decision).toBe('deny');
  });

  it('a read-only share keeps the guest side to reading', async () => {
    expect((await decide(guestRead, 'milestone_post', { kind: 'progress', title: 't', mission: 7, shared_by: 'alice' })).decision).toBe('deny');
    expect((await decide(guestRead, 'item_comment', { id: 'it_in', body: 'x' }, { lookupItem })).decision).toBe('deny');
  });
});

describe('the owner side', () => {
  it('addresses its own mission by number, never through shared_by', async () => {
    expect((await decide(owner, 'milestone_post', { kind: 'progress', title: 't', mission: 7 })).decision).toBe('allow');
    expect((await decide(owner, 'milestone_post', { kind: 'progress', title: 't', mission: 7, shared_by: 'carol' })).decision).toBe('deny');
    expect((await decide(owner, 'item_comment', { id: '#12', body: 'x', shared_by: 'alice' }, { lookupItem })).decision).toBe('deny');
  });
});

describe('a turn started by a comment on an item', () => {
  it('has no room: room tools are blocked, foreign_action_request is not', async () => {
    expect((await decide(itemOwner, 'agent_chat_send', { room_id: 'room-1', message: 'x' })).decision).toBe('deny');
    expect((await decide(itemOwner, 'agent_chat_send', { message: 'x' })).decision).toBe('deny');
    expect((await decide(itemOwner, 'foreign_action_request', { tool_name: 'Bash', tool_input: {}, why: 'w' })).decision).toBe('allow');
    expect((await decide(itemOwner, 'item_comment', { id: 'it_in', body: 'thanks' }, { lookupItem })).decision).toBe('allow');
    expect((await decide(itemGuest, 'item_comment', { id: 'it_in', body: 'thanks' }, { lookupItem })).decision).toBe('allow');
    expect(foreignRouteAllowed(itemOwner, '/agent-chat-send', { room_id: undefined })).toBe(false);
    expect(foreignRouteAllowed(itemOwner, '/foreign-action-request', {})).toBe(true);
  });

  it('is told where it came from and how to answer, in the bridge\'s voice', () => {
    const b = foreignTurnBanner(itemOwner);
    expect(b).toMatch(/started by bob, another person — not by your user — commenting on item it_5 \(#5\)/);
    expect(b).toMatch(/answer bob with item_comment on item it_5/);
    expect(b).not.toMatch(/agent_chat_send/);
    const g = foreignTurnBanner(itemGuest);
    expect(g).toMatch(/milestone_post with shared_by "alice" and mission: 7/);
    expect(foreignTurnBanner({ ...itemOwner, mission: null })).toMatch(/cannot use the tracker/);
    expect(allowanceTurnText(itemOwner, { toolName: 'Bash', decision: 'allow', why: 'w' })).toMatch(/tell bob on the item/);
    expect(actionRequestItem({ turn: itemOwner, toolName: 'Bash', toolInput: {}, why: 'w' }).title).toMatch(/asked on a shared item by bob/);
  });
});

describe('both layers agree', () => {
  // How ask-user.js dispatches each tool call to a bridge route.
  const routeOf = (tool, input) => ({
    mission_get: input.shared_by ? '/sharing/shared_get' : '/missions/get',
    milestone_post: input.shared_by ? '/sharing/shared_post' : '/missions/post',
    item_get: '/items/get',
    item_comment: input.shared_by ? '/sharing/shared_item_comment' : '/items/comment',
    item_create: input.shared_by ? '/sharing/shared_item_create' : '/items/create',
    item_close: input.shared_by ? '/sharing/shared_item_close' : '/items/close',
    mission_status: input.shared_by ? '/sharing/shared_status' : '/missions/status',
  }[tool]);
  const calls = [
    ['mission_get', { num: 7 }], ['mission_get', { num: 7, shared_by: 'alice' }],
    ['milestone_post', { kind: 'progress', title: 't', mission: 7 }], ['milestone_post', { kind: 'progress', title: 't', mission: 7, shared_by: 'alice' }],
    ['item_get', { id: 'it_in' }],
    ['item_comment', { id: 'it_in', body: 'x' }], ['item_comment', { id: '#12', body: 'x', shared_by: 'alice' }],
    ['item_create', { kind: 'task', title: 't', mission: 7, shared_by: 'alice' }], ['item_close', { id: 'it_in', resolution: 'done', shared_by: 'alice' }],
    ['mission_status', { status: 's', mission: 7, shared_by: 'alice' }],
  ];
  for (const turn of [owner, guestRead, guestContrib, itemOwner, itemGuest]) {
    it(`every call the hook allows reaches its route, and nothing more (${turn.role}${turn.contribute ? ', contribute' : ''}${turn.item ? ', item turn' : ''})`, async () => {
      for (const [tool, input] of calls) {
        const hook = (await decide(turn, tool, input, { lookupItem })).decision === 'allow';
        const route = foreignRouteAllowed(turn, routeOf(tool, input), input);
        if (hook) expect(route, `${tool} ${JSON.stringify(input)}`).toBe(true);
      }
      // Writes beyond milestones and comments are closed at the route layer too.
      for (const p of ['/sharing/shared_item_create', '/sharing/shared_item_close', '/sharing/shared_item_reopen', '/sharing/shared_status', '/sharing/share', '/items/create', '/items/close', '/missions/status']) {
        expect(foreignRouteAllowed(turn, p, {}), p).toBe(false);
      }
    });
  }
  it('the route layer keeps the guest side off owner routes and a read guest off writes', () => {
    expect(foreignRouteAllowed(guestContrib, '/missions/post', {})).toBe(false);
    expect(foreignRouteAllowed(guestContrib, '/missions/get', {})).toBe(false);
    expect(foreignRouteAllowed(guestRead, '/sharing/shared_post', {})).toBe(false);
    expect(foreignRouteAllowed(guestRead, '/sharing/shared_item_comment', {})).toBe(false);
    expect(foreignRouteAllowed(owner, '/sharing/shared_post', {})).toBe(false);
    expect(foreignRouteAllowed(owner, '/sharing/shared_get', {})).toBe(false);
  });
});

function rig({ busy = false, sendOk = true, missionRow = { id: 'ms_1', num: 7, title: 'Fair', owner: { name: 'alice' }, grant: { level: 'contribute' } } } = {}) {
  const sent = [];
  const notices = [];
  const flags = new Set();
  const occupied = { v: busy };
  sendOk = { v: sendOk };
  const sharing = {
    personRoom: vi.fn(async () => ({ status: 200, data: { person_room: { role: 'guest', person: 'alice', room_id: 'room-2', mission: { id: 'ms_1', num: 7, owner: 'alice', title: 'Fair' } } } })),
    mission: vi.fn(async () => ({ status: 200, data: { mission: missionRow } })),
    lookup: vi.fn(async (user, num) => ({ status: 200, data: num === 12 ? { kind: 'item', id: 'it_in' } : { kind: 'mission', id: 'ms_1' } })),
  };
  const items = {
    get: vi.fn(async (id) => ({ status: 200, data: { item: { id, mission_id: id === 'it_in' || id === 'it_5' ? 'ms_1' : 'ms_x' } } })),
    create: async () => ({ status: 201, data: { item: { id: 'it_q', num: 1 } } }),
    close: async () => ({ status: 200, data: {} }),
  };
  const fs = createForeignSessions({
    sharing, items,
    journalConvoIdFor: (s) => `convo-${s.roomId}`,
    sendText: (s, text) => { if (!sendOk.v) return false; sent.push([s.roomId, text, s.foreignTurn]); return true; },
    publishNotice: (c, t) => notices.push([c, t]),
    isOccupied: () => occupied.v,
    flag: { set: (k) => flags.add(k), clear: (k) => flags.delete(k) },
    store: { load: () => ({}), save: () => {} },
  });
  return { fs, sent, notices, flags, occupied, sharing, items, sendOk };
}
const session = () => ({ roomId: 'sess-b', alive: true, foreignTurn: null });
const comment = (id, body) => ({ item_id: 'it_5', num: 5, kind: 'task', title: 'Book the band', action: 'commented', awaiting: 'agent', comment: { id, body, attachments: [{ name: 'quote.pdf', mime: 'application/pdf', blob_ref: 'b1', path: '/tmp/x' }] } });

describe('foreign sessions, phase 3', () => {
  it('a guest room turn learns the grant level from the shared mission', async () => {
    const r = rig();
    const row = await r.fs.refreshContext('room-2');
    expect(row.mission.level).toBe('contribute');
    expect(r.sharing.mission).toHaveBeenCalledWith('ms_1');
    expect(r.fs.turnFor('room-2', 'alice', row)).toEqual({ roomId: 'room-2', person: 'alice', role: 'guest', mission, contribute: true });
    const ro = rig({ missionRow: { id: 'ms_1', num: 7, owner: { name: 'alice' }, grant: { level: 'read' } } });
    const rrow = await ro.fs.refreshContext('room-2');
    expect(ro.fs.turnFor('room-2', 'alice', rrow).contribute).toBeUndefined();
  });

  it('a comment from another person on an own mission\'s item is an owner-side item turn', async () => {
    const r = rig({ missionRow: { id: 'ms_1', num: 7, title: 'Fair' } });
    const s = session();
    expect(await r.fs.deliverItemTurn(s, comment('cm_1', 'Band is booked'), 'bob')).toBe(true);
    expect(r.flags.has('sess-b')).toBe(true);
    const [, text, turn] = r.sent[0];
    expect(turn).toEqual({ roomId: null, person: 'bob', role: 'owner', mission: { id: 'ms_1', num: 7, owner: null, title: 'Fair' }, item: { id: 'it_5', num: 5 } });
    expect(text).toMatch(/^\[Matron: this turn was started by bob, another person/);
    expect(text).toMatch(/📌 Item #5 "Book the band" — bob's agent \(another person\) replied:\nBand is booked/);
    // Files never cross: named, never downloaded, no path.
    expect(text).toMatch(/\[attachment quote\.pdf \(application\/pdf\) — not downloaded/);
    expect(text).not.toMatch(/\/tmp\/x/);
  });

  it('the owner\'s comment on a contributor\'s item is a guest-side turn that may contribute', async () => {
    const r = rig();
    const s = session();
    await r.fs.deliverItemTurn(s, comment('cm_2', 'Thanks'), 'alice');
    expect(s.foreignTurn).toMatchObject({ role: 'guest', contribute: true, mission: { owner: 'alice', num: 7 } });
    // The hook's item lookup resolves their numbers through shared_by.
    expect((await r.fs.check(s, { tool_name: `${A}item_comment`, tool_input: { id: '#12', body: 'ok', shared_by: 'alice' } })).decision).toBe('allow');
    expect(r.sharing.lookup).toHaveBeenCalledWith('alice', 12);
    expect((await r.fs.check(s, { tool_name: 'Bash', tool_input: { command: 'ls' } })).decision).toBe('deny');
    expect(r.fs.routeAllowed(s, '/sharing/shared_post', {})).toBe(true);
    expect(r.fs.routeAllowed(s, '/memory/get', {})).toBe(false);
  });

  it('reads the mission from the marker, names how they wrote, and checks shared_by', async () => {
    const r = rig();
    const s = session();
    const marker = { ...comment('cm_5', 'Typed it myself'), mission_id: 'ms_1', person: { name: 'alice', via: 'user' }, shared_by: { user_id: 2, name: 'alice' } };
    await r.fs.deliverItemTurn(s, marker, 'alice');
    expect(r.items.get).not.toHaveBeenCalled();
    expect(s.foreignTurn).toMatchObject({ role: 'guest', contribute: true, mission: { id: 'ms_1', owner: 'alice' } });
    expect(r.sent[0][1]).toMatch(/alice \(another person, typing themselves\) replied:/);
    // A marker whose shared_by disagrees with the mission gets the narrowest turn.
    const r2 = rig();
    const s2 = session();
    await r2.fs.deliverItemTurn(s2, { ...marker, comment: { id: 'cm_6', body: 'x' }, shared_by: { user_id: 3, name: 'carol' } }, 'carol');
    expect(s2.foreignTurn.mission).toBe(null);
  });

  it('a turn that could not be started is not marked delivered: the user is told, and a replay gets through', async () => {
    const r = rig({ sendOk: false });
    const s = session();
    expect(await r.fs.deliverItemTurn(s, comment('cm_7', 'x'), 'bob')).toBe(false);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0][1]).toMatch(/Not delivered/);
    expect(s.foreignTurn).toBe(null);
    r.sendOk.v = true;
    expect(await r.fs.deliverItemTurn(s, comment('cm_7', 'x'), 'bob')).toBe(true);
    expect(r.sent).toHaveLength(1);
  });

  it('an unreadable item or mission gives the narrowest turn', async () => {
    const r = rig();
    r.items.get.mockResolvedValueOnce({ status: 404, data: { error: 'not_found' } });
    const s = session();
    await r.fs.deliverItemTurn(s, comment('cm_3', 'x'), 'bob');
    expect(s.foreignTurn).toEqual({ roomId: null, person: 'bob', role: 'guest', mission: null, item: { id: 'it_5', num: 5 } });
  });

  it('parks behind a running turn, delivers once, and ignores a replay', async () => {
    const r = rig({ busy: true });
    const s = session();
    expect(await r.fs.deliverItemTurn(s, comment('cm_4', 'x'), 'alice')).toBe(true);
    expect(r.sent).toEqual([]);
    expect(r.fs.hasParked(s)).toBe(true);
    expect(await r.fs.deliverItemTurn(s, comment('cm_4', 'x'), 'alice')).toBe(false);
    r.occupied.v = false;
    expect(r.fs.drainParked(s)).toBe(true);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0][1]).toMatch(/^\[Matron: this turn was started by alice/);
    expect(s.foreignTurn).toMatchObject({ role: 'guest', item: { id: 'it_5' } });
    expect(r.fs.hasParked(s)).toBe(false);
  });
});

describe('the journal input router', () => {
  const payload = { item_id: 'it_5', num: 5, kind: 'task', title: 'T', action: 'commented', awaiting: 'agent', comment: { id: 'cm', body: 'x', attachments: [] } };
  const deps = (over = {}) => ({
    isControlConvo: () => false, handleControlCommand: vi.fn(), findSessionByConvoId: vi.fn(() => ({ claudeSessionId: 'convo-1' })),
    routeTextToSession: vi.fn(), routePromptReply: vi.fn(), noticeUnknownConvo: vi.fn(), routeItemToSession: vi.fn(),
    log: { warn: () => {}, error: () => {} }, ...over,
  });
  const frame = (o) => ({ kind: 'journal', seq: 3, convo_id: 'convo-1', ts: 1, type: 'item', payload, ...o });

  it('routes another person\'s item marker with the person named, so the turn is a foreign one', () => {
    const d = deps();
    createJournalInputConsumer(d)(frame({ sender: 'person:bob' }));
    expect(d.routeItemToSession).toHaveBeenCalledWith({ claudeSessionId: 'convo-1' }, { payload, seq: 3 }, { username: 'bob', person: 'bob' });
  });

  it('drops a bare person: sender, a person: handover stage and a person: text outside a room', () => {
    const d = deps();
    const c = createJournalInputConsumer(d);
    c(frame({ sender: 'person:' }));
    c(frame({ sender: 'person:bob', payload: { ...payload, action: 'updated', handover: { stage: 'offered', from_convo_id: 'a', to_convo_id: 'b' } } }));
    c(frame({ sender: 'person:bob', type: 'text', payload: { body: 'hi' } }));
    expect(d.routeItemToSession).not.toHaveBeenCalled();
    expect(d.routeTextToSession).not.toHaveBeenCalled();
  });
});

describe('wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  it('journalOnItem hands another person\'s marker to the foreign path before anything else', () => {
    const start = index.indexOf('function journalOnItem(');
    const body = index.slice(start, index.indexOf('\n}\n', start));
    const person = body.indexOf('if (ctx?.person) {');
    expect(person).toBeGreaterThan(-1);
    expect(person).toBeLessThan(body.indexOf('_agentRestartCount = 0'));
    expect(person).toBeLessThan(body.indexOf('itemTurnRouter('));
    const fn = index.slice(index.indexOf('function deliverForeignItemTurn('));
    expect(fn.slice(0, 600)).toMatch(/if \(session\?\.codex\) \{[\s\S]*?return;/);
  });
  it('mounts every contributor route, and the tools reach them with shared_by', () => {
    const mount = index.split('\n').find((l) => l.includes('const sharingRoute = url.pathname.match('));
    for (const op of ['shared_post', 'shared_status', 'shared_item_create', 'shared_item_comment', 'shared_item_close', 'shared_item_reopen']) {
      expect(mount).toMatch(new RegExp(`[|(]${op}[|)]`));
      expect(askUser).toMatch(new RegExp(`callSharing\\('${op}'`));
    }
    expect(askUser).toMatch(/level: z\.enum\(\['read', 'contribute', 'owner'\]\)/);
  });
});
