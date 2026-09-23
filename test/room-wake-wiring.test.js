import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROOM_WAKE_NOTICE } from '../lib/room-delivery.js';

// Source-text assertions on index.js (the reminders-wiring.test.js idiom:
// index.js boots the bridge and has no unit harness). What is pinned here is
// the contract Dan asked for on 2026-09-21: a Matron conversation keeps its
// agent-chat rooms across everything that ends the claude PROCESS but not
// the conversation — the one-hour idle reap, !stop, a bridge restart, the
// box idle-stopping — and a room message for a sleeping conversation wakes
// it, exactly as an item reply or a chat request does. Before this, every
// non-restart teardown marked the session's rooms `left` (terminal) and
// told the peer, so the auto-resumed session came back with no rooms and
// the pair's next agent_chat_start opened a duplicate room.
describe('rooms survive session teardown', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');

  function fnBody(name) {
    const start = index.indexOf(`function ${name}(`);
    expect(start, `function ${name} is missing from index.js`).toBeGreaterThan(-1);
    const next = index.indexOf('\nfunction ', start + 1);
    return index.slice(start, next === -1 ? undefined : next);
  }

  it('terminal session teardown no longer leaves the session\'s rooms', () => {
    const body = fnBody('journalEvictConvoInput');
    expect(body).not.toMatch(/agentRooms\.forSession\(/);
    expect(body).not.toMatch(/agentRooms\.setState\(/);
    expect(body).not.toMatch(/agentRooms\.setGuestState\(/);
    expect(body).not.toMatch(/agentInvites\.leave\(/);
  });

  it('a room frame for a non-live session wakes it through the persisted session record', () => {
    const body = fnBody('deliverRoomFrameTo');
    expect(body).toMatch(/journalResumeRoom\(room\.sessionRoomId, ROOM_WAKE_NOTICE\)/);
    expect(index).toMatch(/import \{[^}]*\bROOM_WAKE_NOTICE\b[^}]*\} from '\.\/lib\/room-delivery\.js'/);
    expect(ROOM_WAKE_NOTICE).toMatch(/^⏳ /);
  });

  it('only a room whose session cannot be resumed is left, lazily, when a peer writes to it', () => {
    const body = fnBody('deliverRoomFrameTo');
    expect(body).toMatch(/orphanRoomBinding\(frame\.convo_id, room\.sessionRoomId\)/);
    const orphan = fnBody('orphanRoomBinding');
    expect(orphan).toMatch(/agentRooms\.bindingFor\(roomId, sessionKey\)/);
    expect(orphan).toMatch(/agentInvites\.leave\(\{ roomId \}\)/);
    expect(orphan).toMatch(/agentRooms\.setState\(roomId, 'left'\)/);
    expect(orphan).toMatch(/agentRooms\.setGuestState\(roomId, 'left'\)/);
    expect(orphan).toMatch(/journalNotifyRoomEvent\(roomId, 'left the room', \{ sessionKey: otherKey \}\)/);
  });

  it('a muted binding never wakes a sleeping session — the mute is decided before the wake', () => {
    // Bugbot on #288: journalResumeRoom ran before roomFrameDisposition, so a
    // muted binding still respawned the reaped session on every peer message,
    // then dropped the frame as muted-drop. Mute must keep the session asleep.
    const body = fnBody('deliverRoomFrameTo');
    const gate = body.indexOf('roomFrameDisposition(');
    const wake = body.indexOf('journalResumeRoom(');
    expect(gate).toBeGreaterThan(-1);
    expect(wake).toBeGreaterThan(gate);
    // The muted branch returns before the wake is reached.
    const muted = body.slice(body.indexOf("if (disposition !== 'deliver')"), wake);
    expect(muted).toMatch(/\n {4}return;\n {2}\}/);
    // Dan's own message into a muted, sleeping conversation still gets its
    // receipt there, so it does not look lost — without waking it.
    expect(muted).toMatch(/live \? journalConvoIdFor\(session\) : sleepingConvoIdFor\(room\.sessionRoomId\)/);
    expect(muted).toMatch(/ROOM_MUTED_NOT_DELIVERED_NOTICE/);
    expect(fnBody('sleepingConvoIdFor')).toMatch(/loadPersistedSessions\(\)\[roomId\]/);
  });

  it('tells the agent and the guidance that rooms outlive restarts and sleeps', () => {
    for (const [name, text] of [['BRIDGE_CLAUDE.md', claudeMd], ['BRIDGE_CODEX.md', codexMd], ['ask-user.js', askUser]]) {
      expect(text, `${name} should say rooms survive a restart / reap / sleep`).toMatch(/room[^\n]*(restart|asleep|sleep|reap)/i);
    }
  });
});
