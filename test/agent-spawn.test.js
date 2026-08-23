import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createAgentSpawnHandlers } from '../lib/agent-spawn.js';
import { createAgentRooms } from '../lib/agent-rooms.js';

// Fake publisher + recording rooms/notifyParent, modeled on agent-chat.test.js's
// fake-publisher style. `sent` records every sendRoomOp frame in order so
// arm-before-send sequencing is assertable.
function mk(overrides = {}) {
  const sent = [];
  const notices = [];
  const publisher = {
    identity: overrides.identity ?? (() => ({ device_id: 7 })),
    sendRoomOp: overrides.sendRoomOp ?? ((frame) => { sent.push(frame); return true; }),
  };
  const roomsCalls = [];
  // Stateful fake: record() both logs the call (existing assertions read
  // `calls`) AND merges into a store so get() can observe a pre-existing
  // binding — the same-box path relies on rooms.get(). A test can pass its own
  // `rooms` (e.g. a real createAgentRooms) via overrides.rooms.
  const roomsStore = new Map();
  const rooms = overrides.rooms ?? {
    record: (roomId, fields) => {
      roomsCalls.push({ roomId, fields });
      roomsStore.set(roomId, { ...(roomsStore.get(roomId) || {}), ...fields });
      return { ...roomsStore.get(roomId) };
    },
    get: (roomId) => { const r = roomsStore.get(roomId); return r ? { ...r } : null; },
    isActive: () => true,
    calls: roomsCalls,
  };
  const sessions = overrides.sessions ?? new Map([['sess-1', { roomId: 'sess-1' }]]);
  const notifyParent = vi.fn((args) => notices.push(args));
  const handlers = createAgentSpawnHandlers({
    sessions,
    publisher,
    rooms,
    journalConvoIdFor: overrides.journalConvoIdFor ?? (() => 'convo-1'),
    notifyParent,
    targetsTimeoutMs: overrides.targetsTimeoutMs ?? 20,
    pendingTimeoutMs: overrides.pendingTimeoutMs ?? 20,
    handledTtlMs: overrides.handledTtlMs,
    sweepIntervalMs: overrides.sweepIntervalMs,
    log: { warn: () => {} },
  });
  return { handlers, sent, notices, rooms, sessions, notifyParent };
}

describe('createAgentSpawnHandlers', () => {
  describe('boxes', () => {
    it('happy path — sends spawn_targets, resolves boxes on targets frame', async () => {
      const { handlers, sent } = mk();
      const p = handlers.boxes({ roomId: 'sess-1' });
      // Frame sent synchronously by sendRoomOp before we can inspect it here
      // because handlers.boxes armed the waiter first — assert the send.
      expect(sent).toHaveLength(1);
      expect(sent[0].op).toBe('spawn_targets');
      expect(typeof sent[0].request_id).toBe('string');
      const boxesPayload = [{ device_id: 2, name: 'eric', online: true, folders: [], activity: { live_sessions: 0, last_hour: [] } }];
      handlers.onSpawnFrame({ kind: 'spawn', event: 'targets', request_id: sent[0].request_id, boxes: boxesPayload });
      const res = await p;
      expect(res).toEqual({ status: 200, body: { boxes: boxesPayload } });
    });

    it('identity unknown -> 409, fails closed, no frame sent', async () => {
      const { handlers, sent } = mk({ identity: () => null });
      const res = await handlers.boxes({ roomId: 'sess-1' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/journal identity/i);
      expect(sent).toHaveLength(0);
    });

    it('sendRoomOp returns false -> 502 journal_unreachable, waiter cleaned up', async () => {
      let capturedRid = null;
      const { handlers } = mk({ sendRoomOp: (frame) => { capturedRid = frame.request_id; return false; } });
      const res = await handlers.boxes({ roomId: 'sess-1' });
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/journal unreachable/i);
      // Waiter cleanup proven behaviourally: a frame arriving late for the
      // now-abandoned request_id must not be able to resolve anything (it
      // was already settled/removed when the send failed) — no throw either.
      expect(capturedRid).toBeTruthy();
      expect(() => handlers.onSpawnFrame({ kind: 'spawn', event: 'targets', request_id: capturedRid, boxes: [] })).not.toThrow();
    });

    it('timeout -> 504, waiters map ends up empty', async () => {
      const { handlers, sent } = mk({ targetsTimeoutMs: 20 });
      const res = await handlers.boxes({ roomId: 'sess-1' });
      expect(res.status).toBe(504);
      expect(sent).toHaveLength(1);
      // Waiter cleanup proven indirectly: a late frame for the same
      // request_id now settles nothing (no throw, no crash) because the
      // timeout already deleted the waiter.
      expect(() => handlers.onSpawnFrame({ kind: 'spawn', event: 'targets', request_id: sent[0].request_id, boxes: [] })).not.toThrow();
    });

    it('unknown caller session -> 404', async () => {
      const { handlers } = mk();
      const res = await handlers.boxes({ roomId: 'nope' });
      expect(res.status).toBe(404);
    });
  });

  describe('sessionStart', () => {
    const good = { roomId: 'sess-1', device_id: 2, workdir: '/w', task: 'do the thing', topic: 'T' };

    it('happy path — sends spawn_request, resolves pending status on ack', async () => {
      const { handlers, sent } = mk();
      const p = handlers.sessionStart(good);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        op: 'spawn_request',
        request_id: sent[0].request_id,
        from_convo_id: 'convo-1',
        target_device_id: 2,
        workdir: '/w',
        task: 'do the thing',
        topic: 'T',
      });
      handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: sent[0].request_id, spawn_id: 'row-1' });
      const res = await p;
      expect(res).toEqual({ status: 200, body: { status: 'pending', spawn_id: 'row-1' } });
    });

    it('validates task / topic / device_id / workdir before sending any frame', async () => {
      const { handlers, sent } = mk();
      const cases = [
        { ...good, task: undefined },
        { ...good, task: 'x'.repeat(2001) },
        { ...good, topic: 'x'.repeat(201) },
        { ...good, device_id: '2' },
        { ...good, device_id: 2.5 },
        { ...good, workdir: undefined },
        { ...good, workdir: '' },
      ];
      for (const c of cases) {
        const res = await handlers.sessionStart(c);
        expect(res.status).toBe(400);
      }
      expect(sent).toHaveLength(0);
    });

    it('journal op error: conflict maps to 409 with detail; unknown ref returns false', async () => {
      const { handlers, sent } = mk();
      const p = handlers.sessionStart(good);
      expect(sent).toHaveLength(1);
      const rid = sent[0].request_id;
      expect(handlers.onOpError({ code: 'not-a-ref', ref: 'nonexistent-ref-xyz', detail: 'x' })).toBe(false);
      const consumed = handlers.onOpError({ code: 'conflict', ref: rid, detail: 'too many requests awaiting user approval' });
      expect(consumed).toBe(true);
      const res = await p;
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('too many requests awaiting user approval');
    });

    it('agent_unreachable -> 502 target box is offline; not_found -> 404', async () => {
      const { handlers: h1, sent: s1 } = mk();
      const p1 = h1.sessionStart(good);
      h1.onOpError({ code: 'agent_unreachable', ref: s1[0].request_id, detail: 'offline' });
      const r1 = await p1;
      expect(r1.status).toBe(502);
      expect(r1.body.error).toMatch(/offline/i);

      const { handlers: h2, sent: s2 } = mk();
      const p2 = h2.sessionStart(good);
      h2.onOpError({ code: 'not_found', ref: s2[0].request_id, detail: 'no such box' });
      const r2 = await p2;
      expect(r2.status).toBe(404);
    });

    it('session with no journal convo id -> 409', async () => {
      const { handlers, sent } = mk({ journalConvoIdFor: () => null });
      const res = await handlers.sessionStart(good);
      expect(res.status).toBe(409);
      expect(sent).toHaveLength(0);
    });

    it('timeout -> 504', async () => {
      const { handlers } = mk({ pendingTimeoutMs: 20 });
      const res = await handlers.sessionStart(good);
      expect(res.status).toBe(504);
    });
  });

  describe('outcomes', () => {
    async function armStarted(overrides = {}) {
      const ctx = mk(overrides);
      const p = ctx.handlers.sessionStart({ roomId: 'sess-1', device_id: 2, workdir: '/w', task: 'do the thing', topic: 'T' });
      const rid = ctx.sent[0].request_id;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: rid, spawn_id: 'row-1' });
      await p;
      return ctx;
    }

    it('started — rooms.record called, notifyParent once, text mentions started + room id', async () => {
      const ctx = await armStarted();
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-9', child_convo_id: 'child-1' });
      expect(ctx.rooms.calls).toHaveLength(1);
      expect(ctx.rooms.calls[0].roomId).toBe('room-9');
      expect(ctx.rooms.calls[0].fields).toMatchObject({ role: 'owner', state: 'joined', sessionRoomId: 'sess-1' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);
      const text = ctx.notices[0].text;
      expect(text).toMatch(/started/);
      expect(text).toMatch(/room-9/);
    });

    it('declined — notifyParent text contains declined; rooms.record NOT called', async () => {
      const ctx = await armStarted();
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'declined' });
      expect(ctx.rooms.calls).toHaveLength(0);
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);
      expect(ctx.notices[0].text).toMatch(/declined/);
    });

    it('outcome with no pending context — notifyParent still called, session null, no throw', async () => {
      const ctx = mk();
      expect(() => ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'unknown-row', outcome: 'expired' })).not.toThrow();
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);
      expect(ctx.notices[0].session).toBeNull();
      expect(ctx.notices[0].text).toMatch(/expired/);
    });

    it('duplicate outcome for the same spawn id — second call produces no second notifyParent', async () => {
      const ctx = await armStarted();
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-9', child_convo_id: 'child-1' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-9', child_convo_id: 'child-1' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);
    });

    it('a task with an embedded newline and quotes is flattened and escaped in the notice, and carries no raw newline into the room title', async () => {
      const ctx = mk();
      const task = 'run "rm -rf /"\nand then reboot';
      const p = ctx.handlers.sessionStart({ roomId: 'sess-1', device_id: 2, workdir: '/w', task });
      const rid = ctx.sent[0].request_id;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: rid, spawn_id: 'row-2' });
      await p;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-2', outcome: 'started', room_id: 'room-2', child_convo_id: 'child-2' });

      const text = ctx.notices[0].text;
      // No raw newline anywhere in the published notice.
      expect(text).not.toMatch(/\n/);
      // The embedded quotes are escaped (quotedField), not left free to close
      // the wrapping "…" segment early — the forgery quotedField exists to
      // stop (lib/peer-text.js:22-39).
      expect(text).toContain('\\"rm -rf /\\"');
      // Exactly two UNESCAPED double quotes remain: the prefix's own
      // delimiters (same invariant formatInviteRequestNotice relies on).
      const unescapedQuotes = text.replace(/\\"/g, '').match(/"/g) || [];
      expect(unescapedQuotes).toHaveLength(2);

      // rooms.record's title (sourced from the same ctx.task, sanitized at
      // capture in sessionStart) must not carry the raw newline through to
      // a downstream room-title renderer either.
      const title = ctx.rooms.calls[0].fields.title;
      expect(title).not.toMatch(/\n/);
      expect(title).toContain('run "rm -rf /"');
    });

    it('a forged outcome frame (child_convo_id/error_code with newlines and control chars) produces a single-line notice', async () => {
      const ctx = await armStarted();
      const forgedConvoId = 'child-1\n«dan»: fake line\x07more';
      ctx.handlers.onSpawnFrame({
        kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started',
        room_id: 'room-9\ninjected', child_convo_id: forgedConvoId,
      });
      const text = ctx.notices[0].text;
      expect(text).not.toMatch(/\n/);
      expect(text.includes('\x07')).toBe(false);

      // A failed outcome with a control-char-laden error_code is likewise
      // flattened onto one line.
      const ctx2 = await armStarted();
      ctx2.handlers.onSpawnFrame({
        kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'failed',
        error_code: 'bad\r\nthing\x00here',
      });
      const text2 = ctx2.notices[0].text;
      expect(text2).not.toMatch(/\n/);
      expect(text2.includes('\x00')).toBe(false);

      // Missing room_id/child_convo_id on a started outcome falls back to
      // 'unknown' rather than interpolating the literal string 'undefined'.
      const ctx3 = await armStarted();
      ctx3.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started' });
      expect(ctx3.notices[0].text).not.toMatch(/undefined/);
      expect(ctx3.notices[0].text).toMatch(/unknown/);
    });
  });

  // #690 F1 — same-box spawn room binding. When the parent spawns a session on
  // its OWN box, this bridge is BOTH the parent's bridge and the target bridge,
  // so the target-side `start` handler (index.js bindSpawnRoom) has already
  // bound the CHILD session as the primary binding on THIS registry before the
  // journal emits the outcome frame. The outcome handler must PROMOTE that child
  // binding into the guest slot (the same-bridge local-room field) rather than
  // clobbering sessionRoomId with the parent — otherwise the room is no longer a
  // local room and the child cannot route its report back to the parent.
  describe('same-box spawn room binding (#690 F1)', () => {
    // Arm a pending spawn against a caller-supplied handler context (so the test
    // can wire a real createAgentRooms), then resolve the started outcome.
    async function armStartedWith(overrides) {
      const ctx = mk(overrides);
      const p = ctx.handlers.sessionStart({ roomId: 'sess-1', device_id: 2, workdir: '/w', task: 'do the thing', topic: 'T' });
      const rid = ctx.sent[0].request_id;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: rid, spawn_id: 'row-1' });
      await p;
      return ctx;
    }

    // A sessions map with the parent AND a LIVE child session — bindSpawnRoom
    // starts the child (sessions.set) during the start RPC, so by outcome time
    // the child is live on this bridge. The promotion requires that liveness.
    const childKey = 'child-session-room-key';
    const sameBoxSessions = () => new Map([
      ['sess-1', { roomId: 'sess-1' }],
      [childKey, { roomId: childKey }],
    ]);

    it('promotes the pre-bound local child binding into guestSessionRoomId; parent becomes owner; child can route', async () => {
      const rooms = createAgentRooms();
      // Simulate the target-side bindSpawnRoom (index.js:827): on a same-box
      // spawn it bound the CHILD session as the primary binding, keyed by the
      // child's BRIDGE session key (NOT its journal convo id).
      rooms.record('room-9', { role: 'guest', state: 'joined', sessionRoomId: childKey });

      const ctx = await armStartedWith({ rooms, sessions: sameBoxSessions() });
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-9', child_convo_id: 'child-convo-distinct' });

      const room = rooms.get('room-9');
      // Owner binding is the parent; the child binding was NOT clobbered — it
      // moved to the guest slot, so the room is now a local (same-bridge) room.
      expect(room.role).toBe('owner');
      expect(room.state).toBe('joined');
      expect(room.sessionRoomId).toBe('sess-1');
      expect(room.guestSessionRoomId).toBe(childKey);
      expect(room.guestState).toBe('joined');

      // The child routes its report through the guest binding, keyed by its
      // bridge session key — proving end-to-end the report channel resolves.
      expect(rooms.bindingFor('room-9', childKey)).toEqual({ role: 'guest', state: 'joined', binding: 'guest' });
      // …and the parent still holds the primary owner binding.
      expect(rooms.bindingFor('room-9', 'sess-1')).toEqual({ role: 'owner', state: 'joined', binding: 'primary' });
      // The child's session key is discoverable for this room (teardown/routing).
      expect(rooms.forSession(childKey).some((r) => r.roomId === 'room-9')).toBe(true);
    });

    it('uses the key bindSpawnRoom stored, NOT frame.child_convo_id (a fresh session key differs from its journal convo id)', async () => {
      const rooms = createAgentRooms();
      rooms.record('room-9', { role: 'guest', state: 'joined', sessionRoomId: childKey });

      const ctx = await armStartedWith({ rooms, sessions: sameBoxSessions() });
      // child_convo_id is deliberately distinct from the child's session key.
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-9', child_convo_id: 'child-convo-distinct' });

      const room = rooms.get('room-9');
      expect(room.guestSessionRoomId).toBe(childKey);
      expect(room.guestSessionRoomId).not.toBe('child-convo-distinct');
    });

    it('cross-box outcome is unchanged — no pre-existing local record, so owner-only, guestSessionRoomId stays null', async () => {
      const rooms = createAgentRooms();
      const ctx = await armStartedWith({ rooms });
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-cross', child_convo_id: 'child-remote' });

      const room = rooms.get('room-cross');
      expect(room.role).toBe('owner');
      expect(room.state).toBe('joined');
      expect(room.sessionRoomId).toBe('sess-1');
      // Remote child — NOT a local session on this box; the local-room field
      // must stay null so routing never misroutes to a non-existent local session.
      expect(room.guestSessionRoomId).toBeNull();
      // bindingFor for a stranger key returns null (nothing to misroute to).
      expect(rooms.bindingFor('room-cross', 'child-remote')).toBeNull();
    });

    // Provenance hardening (#690 F1, Codex review): the promotion must not fire
    // on any single-ended record that merely happens to sit at the room id.
    it('does NOT promote a single-ended record whose session is not live on this bridge', async () => {
      const rooms = createAgentRooms();
      // A guest/joined record whose session key is NOT in the sessions map —
      // a stale persisted binding, not the child bindSpawnRoom just started.
      rooms.record('room-9', { role: 'guest', state: 'joined', sessionRoomId: 'ghost-key' });
      // sessions holds only the parent — 'ghost-key' is not live.
      const ctx = await armStartedWith({ rooms });
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-9', child_convo_id: 'child-1' });

      const room = rooms.get('room-9');
      expect(room.sessionRoomId).toBe('sess-1');
      expect(room.guestSessionRoomId).toBeNull();
      // The stale binding gained no routing.
      expect(rooms.bindingFor('room-9', 'ghost-key')).toBeNull();
    });

    it('does NOT promote a record that is not a joined guest (wrong role/state)', async () => {
      const rooms = createAgentRooms();
      // An owner/pending record at this room id — does not match bindSpawnRoom's
      // {role:'guest', state:'joined'} write, so it is not treated as the child
      // even though its session is live.
      rooms.record('room-9', { role: 'owner', state: 'pending', sessionRoomId: childKey });
      const ctx = await armStartedWith({ rooms, sessions: sameBoxSessions() });
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-9', child_convo_id: 'child-1' });

      const room = rooms.get('room-9');
      expect(room.sessionRoomId).toBe('sess-1');
      expect(room.guestSessionRoomId).toBeNull();
    });
  });

  describe('frame hygiene', () => {
    it('malformed frames -> no throw, no effect', () => {
      const { handlers, notifyParent } = mk();
      const bad = [
        null,
        undefined,
        {},
        { kind: 'spawn' },
        { kind: 'spawn', event: 42 },
        { kind: 'invite', event: 'targets', request_id: 'x' },
        { kind: 'spawn', event: 'unknown-event', request_id: 'x' },
      ];
      for (const f of bad) {
        expect(() => handlers.onSpawnFrame(f)).not.toThrow();
      }
      expect(notifyParent).not.toHaveBeenCalled();
    });
  });

  describe('pendingSpawns tombstone sweep', () => {
    it('prunes a resolved (tombstoned) spawn after handledTtlMs, but a still-pending context survives the same sweep untouched', async () => {
      const ctx = mk({ handledTtlMs: 5, sweepIntervalMs: 5 });

      // Spawn "live": acked but never given an outcome — a genuinely
      // in-flight context that must survive any amount of sweeping (the
      // sweep only ever touches tombstoned/HANDLED entries).
      const pLive = ctx.handlers.sessionStart({ roomId: 'sess-1', device_id: 2, workdir: '/w', task: 'long-running task' });
      const ridLive = ctx.sent[0].request_id;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: ridLive, spawn_id: 'row-live' });
      await pLive;

      // Spawn "tomb": acked and resolved right away — its context tombstones.
      const pTomb = ctx.handlers.sessionStart({ roomId: 'sess-1', device_id: 2, workdir: '/w', task: 'quick task' });
      const ridTomb = ctx.sent[1].request_id;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: ridTomb, spawn_id: 'row-tomb' });
      await pTomb;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-tomb', outcome: 'declined' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);

      // Let the unref'd sweep interval fire at least once past the TTL.
      await new Promise((resolve) => setTimeout(resolve, 60));

      // The tombstone for row-tomb is gone: a second 'declined' frame for
      // the same spawn id now reads as "never tracked" (same as a
      // bridge-restart case) and produces ANOTHER notifyParent — proving
      // the entry was actually pruned rather than deduped forever.
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-tomb', outcome: 'declined' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(2);
      expect(ctx.notices[1].session).toBeNull();

      // row-live was NEVER tombstoned, so the sweep must never have touched
      // it — resolving it now must still find its real context (session
      // non-null, rooms.record called), proving a genuinely pending spawn
      // is immune to the sweep regardless of elapsed time.
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-live', outcome: 'started', room_id: 'room-live', child_convo_id: 'child-live' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(3);
      expect(ctx.notices[2].session).not.toBeNull();
      expect(ctx.notices[2].text).toContain('long-running task');
      expect(ctx.rooms.calls.some((c) => c.roomId === 'room-live')).toBe(true);
    });
  });
});

// Source-inspection pins for the Task 5 wiring, in the style of
// test/agent-chat.test.js's "index.js routes + ask-user.js tools" block —
// that block covers the eight agent-chat tools/routes; this one covers the
// two spawn ones plus the pieces agent-chat.test.js has no reason to touch
// (the rpc-handler capacity/spawn-room deps, and the single-instantiation
// guarantee the factory's unref'd sweep timer depends on).
describe('index.js + ask-user.js spawn wiring (source inspection)', () => {
  const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const askUserSrc = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf-8');

  it('createAgentSpawnHandlers is instantiated exactly once', () => {
    const count = (indexSrc.match(/createAgentSpawnHandlers\(\{/g) || []).length;
    expect(count).toBe(1);
  });

  it('notifyParent falls back to JOURNAL_CONTROL_CONVO_ID when both session and convoId are absent (ctx-null bridge-restart case)', () => {
    const start = indexSrc.indexOf('notifyParent: ({ session, convoId, text }) => {');
    expect(start).toBeGreaterThan(-1);
    const end = indexSrc.indexOf('\n  },', start);
    const body = indexSrc.slice(start, end);
    // The normal cases are untouched…
    expect(body).toMatch(/if \(convoId\) journalPublishNotice\(convoId, text\)/);
    expect(body).toMatch(/if \(session\) \{/);
    expect(body).toMatch(/roomDelivery\.deliver\(session, session\.roomId,/);
    // …and the fallback fires ONLY when session is absent (the `else`) AND
    // convoId is also absent (`!convoId`) — never a THIRD notice alongside
    // the convoId branch above.
    expect(body).toMatch(/\} else if \(!convoId\) \{\s*\n\s*journalPublishNotice\(JOURNAL_CONTROL_CONVO_ID, text\);/);
  });

  it('wires the capacity thunks and spawn-room deps into createRpcRequestHandler', () => {
    const start = indexSrc.indexOf('const journalRpcHandler = createRpcRequestHandler({');
    expect(start).toBeGreaterThan(-1);
    const end = indexSrc.indexOf('\n});', start);
    const args = indexSrc.slice(start, end);
    // Answered from cache only — never awaited, never blocking a reply on a
    // subprocess boot.
    expect(args).toMatch(/getActivity: \(\) => buildActivity\(\{ sessions, persisted: loadPersistedSessions\(\) \}\)/);
    expect(args).toMatch(/getLimits: \(\) => \{ refreshUsageLimits\(DEFAULT_WORKDIR\); return buildLimits\(usageLimitsCache\); \}/);
    expect(args).toMatch(/getDisk: \(\) => buildDisk\(\{ path: DEFAULT_WORKDIR \}\)/);
    expect(args).toMatch(/bindSpawnRoom: \(roomId, session\) => \{[\s\S]{0,200}agentRooms\.record\(roomId, \{ role: 'guest', state: 'joined', sessionRoomId: session\.roomId \}\)/);
    expect(args).toMatch(/unbindSpawnRoom: \(roomId\) => agentRooms\.remove\(roomId\)/);
    expect(args).toMatch(/injectTurn: \(session, text\) => sendTextToSession\(session, text, \{ skipJournalMirror: true \}\)/);
    expect(args).toMatch(/serverLabel: SERVER_LABEL,/);
    expect(indexSrc).toMatch(/import \{ buildActivity, buildLimits, buildDisk \} from '\.\/lib\/spawn-capacity\.js';/);
  });

  it('mounts /agent-boxes and /agent-session-start on agentSpawnHandlers via the throw-isolating adapter, before the /secret regex', () => {
    expect(indexSrc).toMatch(
      /url\.pathname === '\/agent-boxes'[\s\S]{0,120}respondAgentChatRoute\(res, data, agentSpawnHandlers\.boxes,/);
    expect(indexSrc).toMatch(
      /url\.pathname === '\/agent-session-start'[\s\S]{0,120}respondAgentChatRoute\(res, data, agentSpawnHandlers\.sessionStart,/);
    const boxesAt = indexSrc.indexOf(`url.pathname === '/agent-boxes'`);
    const secretAt = indexSrc.indexOf('secretSubmitMatch = url.pathname.match(');
    expect(boxesAt).toBeGreaterThan(-1);
    expect(secretAt).toBeGreaterThan(boxesAt);
  });

  it('declares agent_boxes and agent_session_start in ask-user.js', () => {
    expect(askUserSrc).toMatch(/server\.tool\(\s*\n\s*'agent_boxes',/);
    expect(askUserSrc).toMatch(/server\.tool\(\s*\n\s*'agent_session_start',/);
  });

  const TOOL_WIRING = [
    ['agent_boxes', '/agent-boxes', ['roomId: ROOM_ID']],
    ['agent_session_start', '/agent-session-start', ['roomId: ROOM_ID', 'device_id', 'workdir', 'task', 'topic']],
  ];
  function toolBlock(name) {
    const start = askUserSrc.indexOf(`'${name}',`);
    expect(start, `tool ${name} declared`).toBeGreaterThan(-1);
    const next = askUserSrc.indexOf('server.tool(', start);
    return askUserSrc.slice(start, next === -1 ? undefined : next);
  }
  it('each spawn tool POSTs to its own loopback path with the expected body keys', () => {
    for (const [name, path, keys] of TOOL_WIRING) {
      const block = toolBlock(name);
      expect(block, `${name} fetches ${path}`).toContain('${BRIDGE_API}' + path + '`');
      for (const key of keys) expect(block, `${name} body carries ${key}`).toContain(key);
    }
  });

  it('agent_session_start caps task/topic and types device_id as an integer, matching the journal-enforced limits', () => {
    const block = toolBlock('agent_session_start');
    expect(block).toMatch(/device_id: z\.number\(\)\.int\(\)/);
    expect(block).toMatch(/task: z\.string\(\)\.max\(2000\)/);
    expect(block).toMatch(/topic: z\.string\(\)\.max\(200\)\.optional\(\)/);
  });
});
