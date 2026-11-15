import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSelfCompactHandler, compactCommandFor, BASE_INSTRUCTIONS, COORDINATOR_INSTRUCTIONS, FOCUS_MAX_CHARS, COMMAND_MAX_CHARS } from '../lib/self-compact.js';
import { planSessionControl, validateControlParams, controlNotice } from '../lib/session-control.js';
import { isCompactCommand } from '../lib/compact-priority.js';

// compact_self: a session compacting its own context, parked until its turn
// ends in the same `compact` control slot a Coordinator-sent compact uses.

function harness({ session = {}, now = 1_000_000, ...over } = {}) {
  const calls = [];
  const live = { roomId: '!room:x', alive: true, busy: true, agent: 'claude', ...session };
  let t = now;
  const handler = createSelfCompactHandler({
    getSession: () => (live.alive ? live : null),
    isOccupied: (s) => !!s.busy,
    park: (s, params) => { calls.push(['park', params]); s._deferredControls = { compact: { kind: 'compact', params, id: 'x' } }; },
    apply: async (s, params) => { calls.push(['apply', params]); },
    notify: (s, text) => { calls.push(['notify', text]); },
    now: () => t,
    ...over,
  });
  return { handler, session: live, calls, advance: (ms) => { t += ms; } };
}

describe('compactCommandFor', () => {
  it('is one line, a /compact with the working-state brief, and the Coordinator brief only for the Coordinator', () => {
    const plain = compactCommandFor({ agent: 'claude' });
    expect(plain).toBe(`/compact ${BASE_INSTRUCTIONS}`);
    expect(isCompactCommand(plain)).toBe(true);
    const coord = compactCommandFor({ agent: 'claude', coordinator: true, focus: 'room with gale\nwaits on CI' });
    expect(coord).toContain(COORDINATOR_INSTRUCTIONS);
    expect(coord).toMatch(/Also keep: room with gale waits on CI$/);
    expect(coord).not.toMatch(/\n/);
  });
  it('never passes the interactive paste limit: the focus is cut to fit, the briefs never are', () => {
    expect(COMMAND_MAX_CHARS).toBeLessThan(800);
    const longest = compactCommandFor({ agent: 'claude', coordinator: true, focus: 'x'.repeat(FOCUS_MAX_CHARS) });
    expect(longest.length).toBeLessThanOrEqual(COMMAND_MAX_CHARS);
    expect(longest).toContain(COORDINATOR_INSTRUCTIONS);
    expect(longest).toMatch(/Also keep: x+…$/);
    expect(compactCommandFor({ agent: 'claude', focus: 'y'.repeat(FOCUS_MAX_CHARS) }).length).toBeLessThanOrEqual(COMMAND_MAX_CHARS);
  });
  it('gives Codex the bare command: its native compaction takes no instructions', () => {
    expect(compactCommandFor({ agent: 'codex', coordinator: true, focus: 'x' })).toBe('/compact');
  });
});

describe('/compact-self handler', () => {
  it('parks mid-turn, notifies, and records the time', async () => {
    const { handler, session, calls } = harness({ session: { coordinator: true } });
    const res = await handler({ roomId: '!room:x', reason: 'context at 31%', focus: 'spawn on box-a to check' });
    expect(res).toEqual({ status: 200, body: { ok: true, parked: true } });
    expect(calls[0][0]).toBe('park');
    expect(calls[0][1]).toMatchObject({ action: 'compact', self: true, reason: 'context at 31%' });
    expect(calls[0][1].command).toContain(COORDINATOR_INSTRUCTIONS);
    expect(calls[0][1].command).toMatch(/Also keep: spawn on box-a to check$/);
    expect(calls[1]).toEqual(['notify', '🗜️ Compacting this session once this turn finishes — context at 31%.']);
    expect(session._lastSelfCompactAt).toBe(1_000_000);
  });
  it('applies at once on an idle session', async () => {
    const { handler, calls } = harness({ session: { busy: false } });
    const res = await handler({ roomId: '!room:x' });
    expect(res.body.parked).toBe(false);
    expect(calls.map((c) => c[0])).toEqual(['apply', 'notify']);
    expect(calls[1][1]).toBe('🗜️ Compacting this session now.');
  });
  it('refuses a second call while one is parked, and another within the cooldown', async () => {
    const { handler, session, advance } = harness();
    expect((await handler({ roomId: '!room:x' })).status).toBe(200);
    const again = await handler({ roomId: '!room:x' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/Do not call compact_self again/);
    session._deferredControls = null; // the drain ran it
    advance(10 * 60 * 1000);
    const soon = await handler({ roomId: '!room:x' });
    expect(soon.status).toBe(429);
    expect(soon.body.error).toMatch(/Try again in 20 min/);
    advance(21 * 60 * 1000);
    expect((await handler({ roomId: '!room:x' })).status).toBe(200);
  });
  it('supersedes a Coordinator-sent compact parked in the same slot', async () => {
    const { handler, calls } = harness({ session: { _deferredControls: { compact: { kind: 'compact', params: { convoId: 'c', action: 'compact' }, id: 'old' } } } });
    expect((await handler({ roomId: '!room:x' })).status).toBe(200);
    expect(calls[0][0]).toBe('park');
  });
  it('404s with no live session and 400s on oversize text, touching nothing', async () => {
    const { handler, calls } = harness({ session: { alive: false } });
    expect((await handler({ roomId: '!room:x' })).status).toBe(404);
    const h2 = harness();
    expect((await h2.handler({ roomId: '!room:x', focus: 'f'.repeat(FOCUS_MAX_CHARS + 1) })).status).toBe(400);
    expect((await h2.handler({ roomId: '!room:x', reason: 'r'.repeat(201) })).status).toBe(400);
    expect(calls).toEqual([]);
    expect(h2.calls).toEqual([]);
  });
  it('reports a failed start without recording the cooldown', async () => {
    const { handler, session } = harness({ session: { busy: false }, apply: async () => { throw new Error('gone'); } });
    const res = await handler({ roomId: '!room:x' });
    expect(res.status).toBe(500);
    expect(session._lastSelfCompactAt).toBeUndefined();
  });
});

describe('the parked self-compact in the session-control planner', () => {
  const params = { convoId: '!room:x', action: 'compact', self: true, command: '/compact keep it', reason: 'r' };
  it('applies with its own command once the session is free, and parks while it is not', () => {
    expect(planSessionControl({ params, session: { alive: true } })).toEqual({ kind: 'apply', steps: [{ op: 'compact', command: '/compact keep it' }] });
    expect(planSessionControl({ params, session: { alive: true, busy: true } })).toEqual({ kind: 'park', slot: { kind: 'compact', params } });
  });
  it('a journal-relayed compact can never carry a command', () => {
    const v = validateControlParams({ convo_id: 'c1', action: 'compact', self: true, command: '/compact pwned' });
    expect(v.params).toEqual({ convoId: 'c1', action: 'compact' });
    expect(planSessionControl({ params: { ...v.params, command: '/compact pwned' }, session: { alive: true } }).steps).toEqual([{ op: 'compact' }]);
  });
  it('its notices name no Coordinator', () => {
    expect(controlNotice(params, { phase: 'applied' })).toBe('🗜️ Compacting this session now — r');
    expect(controlNotice(params, { error: 'the session has ended' })).toBe('⚠️ Self-compact refused: the session has ended — r');
  });
});

describe('compact_self wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf-8');
  it('ask-user.js registers compact_self posting to /compact-self with the caller room', () => {
    const start = askUser.indexOf("'compact_self'");
    expect(start).toBeGreaterThan(-1);
    const body = askUser.slice(start, askUser.indexOf('server.tool(', start + 10));
    expect(body).toMatch(/\$\{BRIDGE_API\}\/compact-self/);
    expect(body).toMatch(/roomId: ROOM_ID/);
    expect(body).toMatch(/focus: z\.string\(\)\.max\(300\)\.optional\(\)/);
    expect(body).toMatch(/data\.error/);
  });
  it('session_compact on your own conversation answers as compact_self, not "sent to the target"', () => {
    const fn = askUser.slice(askUser.indexOf('async function sessionControlCall'), askUser.indexOf("'restart_session',"));
    expect(fn).toMatch(/if \(data\.ok === true && typeof data\.parked === 'boolean'\) \{\s*return \{ content: \[\{ type: 'text', text: compactSelfText\(data\.parked\) \}\] \};/);
    expect(fn.indexOf('compactSelfText(data.parked)')).toBeLessThan(fn.indexOf("Sent to the target session's bridge."));
  });
  it('index.js routes /compact-self, parks in the compact control slot and keeps the restart budget', () => {
    expect(src).toMatch(/import \{ createSelfCompactHandler \} from '\.\/lib\/self-compact\.js'/);
    expect(src).toMatch(/url\.pathname === '\/compact-self'[\s\S]{0,80}respondAgentChatRoute\(res, data, selfCompactHandler/);
    expect(src).toMatch(/_deferredControls = \{ \.\.\.\(session\._deferredControls \|\| \{\}\), compact: \{ kind: 'compact', params, id: randomUUID\(\) \} \}/);
    expect(src).toMatch(/journalRouteTextToSession\(current, step\.command \|\| '\/compact', \{ keepRestartBudget: !!step\.command \}\)/);
    expect(src).toMatch(/if \(!keepRestartBudget\) session\._agentRestartCount = 0;/);
    expect(src).toMatch(/compactSelf: \(d\) => selfCompactHandler\(d\)/);
    // The cooldown crosses a crash restart and a recreate, like the restart budget.
    expect(src.match(/restarted\._lastSelfCompactAt = session\._lastSelfCompactAt;/g)).toHaveLength(2);
    expect(src).toMatch(/next\._lastSelfCompactAt = existing\._lastSelfCompactAt;/);
  });
});
