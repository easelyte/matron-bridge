import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createForeignSessions, ALLOW_LABEL } from '../lib/foreign-session.js';

// Where the bridge's PreToolUse gate cannot run (Claude Code's managed
// settings keep its hooks off and no managed gate stands in), a turn another
// person started is not taken: room messages, item comments and the turn an
// "Allow once" tap would start alike.
function rig({ blocked = null, busy = false } = {}) {
  const sent = [];
  const notices = [];
  const closed = [];
  const occupied = { v: busy };
  const fs = createForeignSessions({
    sharing: { personRoom: vi.fn(async () => ({ status: 404, data: {} })) },
    items: {
      get: async () => ({ status: 404 }),
      create: async () => ({ status: 201, data: { item: { id: 'it_1', num: 101 } } }),
      close: async (id, body) => { closed.push([id, body]); return { status: 200, data: {} }; },
    },
    journalConvoIdFor: (s) => `convo-${s.roomId}`,
    sendText: (s, text) => { sent.push([s.roomId, text]); return true; },
    publishNotice: (c, t) => notices.push([c, t]),
    isOccupied: () => occupied.v,
    flag: { set: () => {}, clear: () => {} },
    store: { load: () => ({}), save: () => {} },
    gateBlocked: () => blocked.v,
  });
  blocked = { v: blocked };
  return { fs, sent, notices, closed, occupied, blocked };
}
const session = () => ({ roomId: 'sess-a', alive: true, foreignTurn: null });
const turn = { roomId: 'room-1', person: 'tim', role: 'guest', mission: null };

async function asked(r, s) {
  r.fs.begin(s, turn);
  expect((await r.fs.requestAction(s, { tool_name: 'Bash', tool_input: { command: 'ls' }, why: 'y' })).status).toBe(200);
  r.fs.end(s);
}

describe('gateBlocked', () => {
  it('an Allow once tap starts no turn where the gate cannot run, and says why', async () => {
    const r = rig();
    const s = session();
    await asked(r, s);
    r.blocked.v = 'hooks are off';
    expect(r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: ALLOW_LABEL } })).toBe(true);
    expect(s.foreignTurn).toBe(null);
    expect(r.sent).toEqual([]);
    expect(r.closed[0]).toEqual(['it_1', { resolution: 'answered', comment: 'Not run: hooks are off.' }]);
    expect(r.notices.at(-1)[1]).toMatch(/cannot run on this machine: hooks are off/);
    expect(r.fs.pendingCount()).toBe(0);
  });

  it('a continuation parked behind a busy turn is dropped at the drain once the gate cannot run', async () => {
    const r = rig({ busy: true });
    const s = session();
    await asked(r, s);
    expect(r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: ALLOW_LABEL } })).toBe(true);
    expect(r.fs.hasParked(s)).toBe(true);
    r.blocked.v = 'hooks are off';
    r.occupied.v = false;
    expect(r.fs.drainParked(s)).toBe(false);
    expect(r.fs.hasParked(s)).toBe(false);
    expect(s.foreignTurn).toBe(null);
    expect(r.sent).toEqual([]);
    expect(r.notices.at(-1)[1]).toMatch(/cannot run on this machine: hooks are off/);
  });

  it('with the gate available the tap starts the restricted turn as before', async () => {
    const r = rig();
    const s = session();
    await asked(r, s);
    expect(r.fs.onItemReply(s, { item_id: 'it_1', action: 'commented', comment: { action: ALLOW_LABEL } })).toBe(true);
    expect(s.foreignTurn).toMatchObject({ person: 'tim' });
    expect(r.sent).toHaveLength(1);
  });
});

describe('index.js wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const fnBody = (sig) => {
    const start = index.indexOf(sig);
    expect(start, sig).toBeGreaterThan(-1);
    return index.slice(start, index.indexOf('\n}\n', start));
  };

  it('room messages and item comments from another person check the gate before delivery', () => {
    const before = (body, a, b) => {
      expect(body.indexOf(a), a).toBeGreaterThan(-1);
      expect(body.indexOf(b), b).toBeGreaterThan(-1);
      expect(body.indexOf(a)).toBeLessThan(body.indexOf(b));
    };
    before(fnBody('function deliverRoomFrameTo('), 'const gateReason = foreignGateBlocked(session);', 'const deliverForeign = () =>');
    before(fnBody('function deliverForeignItemTurn('), 'foreignGateBlocked(session)', 'foreignSessions.deliverItemTurn(');
    // A message already queued when the settings changed is checked again at inject.
    before(fnBody('function injectForeignRoomTurn('), 'foreignGateBlocked(session)', 'foreignSessions.inject(');
  });

  it('the foreign sessions get the gate check and arm both flags', () => {
    expect(index).toMatch(/flag: \{ set: setForeignFlags, clear: clearForeignFlags \}/);
    expect(index).toMatch(/gateBlocked: \(session\) => \(session\?\.codex \? null : foreignGateBlocked\(session\)\)/);
    expect(fnBody('function setForeignFlags(')).toMatch(/setForeignFlag\(claudeKey, \{ dir: claudeSessionFlagDir\(\) \}\)/);
    // A failed second write takes the first flag back down before begin() refuses the turn.
    expect(fnBody('function setForeignFlags(')).toMatch(/catch \(e\) \{[\s\S]*clearForeignFlag\(key\);[\s\S]*throw e;/);
  });

  it('an interactive session is refused where only managed hooks run: its turn ends through the bridge\'s own Stop hook', () => {
    const body = fnBody('function foreignGateBlocked(');
    expect(body).toMatch(/if \(session\?\.iv && !bridgeHooksRun\)/);
    // Read fresh each time: no cached answer outlives a settings change.
    expect(fnBody('function readForeignGatePolicy(')).not.toMatch(/60_000|Cache/);
  });

  it('/foreign-check names the session by its Claude session id when no room is given, and a managed call stands aside where the session gate runs', () => {
    const at = index.indexOf("if (url.pathname === '/foreign-check') {");
    const block = index.slice(at, index.indexOf('return;\n      }\n', at + 600));
    expect(block).toMatch(/const room = url\.searchParams\.get\('room'\) \|\| roomForClaudeSessionId\(data\?\.session_id\);/);
    expect(block).toMatch(/if \(managedCall && readForeignGatePolicy\(\)\.bridgeHooksRun\)/);
  });
});
