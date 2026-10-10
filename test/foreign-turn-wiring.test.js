import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRoomDelivery } from '../lib/room-delivery.js';
import { formatAutoJoinedRequest } from '../lib/agent-invites.js';
import { roomEchoLabel } from '../lib/room-delivery.js';

// Foreign turns, as wired into index.js and ask-user.js (index.js boots the
// bridge, so its wiring is pinned by source), plus the room-delivery rule
// that keeps another person's messages in turns of their own.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
const fnBody = (src, sig) => {
  const start = src.indexOf(sig);
  expect(start, sig).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('\n}\n', start));
};

describe('index.js wiring', () => {
  it('every Claude session gets the gate: print spawns and iv settings name the flag path', () => {
    expect(index).toMatch(/buildPrintSessionSettings\(\{ bypass: bypassMode, hooksDir: [\s\S]{0,120}?foreignFlag: foreignFlagPath\(roomId\) \}\)/);
    expect(index).toMatch(/foreignGateEntry\(\{ hooksDir: path\.join\(__dirname, 'hooks'\), apiPort: API_PORT, roomId, foreignFlag: foreignFlagPath\(roomId\) \}\)/);
  });

  it('a foreign turn ends at the print and iv turn-end seams, before the queue or room flush', () => {
    const result = index.slice(index.indexOf("    case 'result': {"));
    const busyOff = result.indexOf('session.busy = false;');
    const end = result.indexOf('foreignSessions.end(session);');
    const flush = result.indexOf('maybeFlushRoomDelivery(session)');
    expect(busyOff).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(busyOff);
    expect(flush).toBeGreaterThan(end);
    const iv = index.slice(index.indexOf('session.onTurnEnd = () => {'));
    expect(iv.indexOf('foreignSessions.end(session);')).toBeLessThan(iv.indexOf('maybeFlushRoomDelivery'));
  });

  it('input of the session\'s own, sent while idle, ends a foreign turn a seam missed; mid-turn input does not', () => {
    const body = fnBody(index, 'function sendToSession(');
    expect(body).toMatch(/if \(!foreign && !session\.busy && session\.foreignTurn\) foreignSessions\.end\(session\);/);
  });

  it('another person\'s room frame becomes a foreign delivery, never an inline reply-wait result', () => {
    const body = fnBody(index, 'function deliverRoomFrameTo(');
    expect(body).toMatch(/const person = personOfSender\(sender\);/);
    expect(body).toMatch(/if \(!person && roomReplyWaiters\.resolve\(/);
    expect(body).toMatch(/foreign: \{ person \}/);
    // Codex has no gate: never a foreign turn there.
    expect(body).toMatch(/if \(session\.codex\) \{[\s\S]*?return;/);
  });

  it('the auto-join turn and the fallback ask of a person room are foreign too', () => {
    expect(fnBody(index, 'async function deliverAutoJoinedRequest(')).toMatch(/\.\.\.\(person \? \{ foreign: \{ person \} \} : \{\}\)/);
    expect(fnBody(index, 'function deliverInviteAsk(')).toMatch(/\.\.\.\(person \? \{ foreign: \{ person \} \} : \{\}\)/);
    expect(fnBody(index, 'function journalInjectInviteRequest(')).toMatch(/frame\.person && session\.codex/);
  });

  it('an "Allow once" tap is applied by the bridge, ahead of the ordinary 📌 turn', () => {
    const body = fnBody(index, 'function journalOnItem(');
    expect(body.indexOf('foreignSessions.onItemReply(session, item?.payload)')).toBeGreaterThan(-1);
    expect(body.indexOf('foreignSessions.onItemReply(')).toBeLessThan(body.indexOf('itemTurnRouter('));
  });

  it('the hook route answers before the generic route gate, and the gate runs before every tool route', () => {
    const check = index.indexOf("if (url.pathname === '/foreign-check') {");
    const gate = index.indexOf('foreignSessions.routeAllowed(gSession, url.pathname, data)');
    const secret = index.indexOf("if (url.pathname === '/secret') {");
    expect(check).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(check);
    expect(secret).toBeGreaterThan(gate);
    for (const route of ['const itemsRoute = ', 'const missionsRoute = ', 'const memoryRoute = ', "'/agent-chat-send'", "'/agent-session-start'", "'/restart-session'"]) {
      const at = index.indexOf(route, gate);
      expect(at, route).toBeGreaterThan(gate);
    }
  });

  it('a parked allowance goes before the room inbox at the free gate', () => {
    const body = fnBody(index, 'function maybeFlushRoomDelivery(');
    expect(body.indexOf('foreignSessions.drainParked(session)')).toBeLessThan(body.indexOf('flushRoomInbox(session)'));
  });
});

describe('ask-user.js tools', () => {
  it('show-file asks the route layer, so an Allow once tap can let one share through', () => {
    expect(index).toContain("foreignAllowed: (s) => foreignSessions.routeAllowed(s, '/show-file', {}),");
  });
  it('session_unshare reports a failed share lookup as a failure, not as "not shared"', () => {
    expect(index).toMatch(/if \(list\?\.status !== 200 \|\| !Array\.isArray\(list\?\.data\?\.session_shares\)\) \{\n\s+r = \{ status: 502/);
  });

  it('registers foreign_action_request, session_share and session_unshare, and a mission on agent_chat_start', () => {
    for (const t of ['foreign_action_request', 'session_share', 'session_unshare']) expect(askUser).toContain(`'${t}',`);
    expect(askUser).toMatch(/mission: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)\.describe\("Only for another person's session/);
  });
});

describe('room delivery keeps another person\'s messages in turns of their own', () => {
  const make = () => {
    const calls = [];
    const d = createRoomDelivery({ isBusy: (s) => !!s.busy, injectTurn: (s, text, messages, meta) => { calls.push({ text, meta }); return true; }, log: { warn: () => {} } });
    return { d, calls };
  };
  const own = (body, roomId = 'r-own') => ({ roomId, roomTitle: 'own', from: 'box2 (agent)', body });
  const foreign = (body, roomId = 'r-tim') => ({ roomId, roomTitle: 'tim', from: "tim's agent (another person)", body, foreign: { person: 'tim' } });

  it('idle: a foreign message is injected with its meta', () => {
    const { d, calls } = make();
    d.deliver({ alive: true }, 'k', foreign('hi'));
    expect(calls[0].meta).toEqual({ foreign: { roomId: 'r-tim', person: 'tim' } });
    d.deliver({ alive: true }, 'k', own('hey'));
    expect(calls[1].meta).toBeUndefined();
  });

  it('busy then flush: own batch first, each foreign room on its own later turn', () => {
    const { d, calls } = make();
    const s = { alive: true, busy: true };
    d.deliver(s, 'k', foreign('a'));
    d.deliver(s, 'k', own('b'));
    d.deliver(s, 'k', foreign('c', 'r-ann'));
    d.deliver(s, 'k', foreign('d'));
    s.busy = false;
    d.flush(s, 'k');
    expect(calls[0].meta).toBeUndefined();
    expect(calls[0].text).toContain('b');
    expect(calls[0].text).not.toContain("tim's agent");
    expect(d.pendingCount('k')).toBe(3);
    d.flush(s, 'k');
    expect(calls[1].meta).toEqual({ foreign: { roomId: 'r-tim', person: 'tim' } });
    expect(calls[1].text).toMatch(/2 messages/);
    d.flush(s, 'k');
    expect(calls[2].meta).toEqual({ foreign: { roomId: 'r-ann', person: 'tim' } });
    expect(d.pendingCount('k')).toBe(0);
  });

  it('the 💬 echo names the person; the auto-join backlog labels their copies', () => {
    expect(roomEchoLabel('person:tim', "tim's agent (another person)")).toBe("tim's agent (another person)");
    const text = formatAutoJoinedRequest({ room_id: 'r', from_name: 'alice', person: { name: 'alice' }, justification: 'talk' }, { events: [{ type: 'text', sender: 'person:alice', payload: { body: 'opening' } }] });
    expect(text).toContain('alice (another person): opening');
    expect(text).toMatch(/ANOTHER PERSON's agent/);
  });
});
