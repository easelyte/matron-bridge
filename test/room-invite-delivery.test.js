import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// index.js boots the bridge and has no unit harness, so these pin the wiring
// by source inspection, like the neighbouring room tests.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function fnBody(header) {
  const start = index.indexOf(header);
  expect(start, `${header} is missing from index.js`).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf('\n}\n', start) + 2);
}

describe('inbound room invites', () => {
  it('only an addressed request is auto-joined; a guessed target gets the accept/refuse ask', () => {
    const body = fnBody('function journalInjectInviteRequest(');
    const gate = body.indexOf('if (!isJoin && !frame.local && addressed) {');
    expect(gate).toBeGreaterThan(-1);
    // The gate hands over to the auto-join helper...
    expect(body.slice(gate, gate + 400)).toContain('deliverAutoJoinedRequest(session, frame, room, { addressed })');
    // ...and the fall-through after it is the ask, for everything the gate let by.
    const rest = body.slice(body.indexOf('return;', gate));
    expect(rest).toContain('deliverInviteAsk(session, frame, room)');
  });
});

describe('deliverRoomFrameTo', () => {
  it('re-reads the bound session after the self-heal flush, before it decides how to deliver', () => {
    const body = fnBody('function deliverRoomFrameTo(');
    const flush = body.indexOf('maybeFlushRoomDelivery(session);');
    expect(flush).toBeGreaterThan(-1);
    const reread = body.indexOf('session = sessions.get(room.sessionRoomId);', flush);
    expect(reread).toBeGreaterThan(flush);
    expect(body.indexOf('live = !!(session && session.alive);', reread)).toBeGreaterThan(reread);
    // The mute / wake / delivery logic below all runs on the refreshed values.
    expect(reread).toBeLessThan(body.indexOf('roomFrameDisposition('));
    expect(body).toMatch(/let live = !!\(session && session\.alive\);/);
  });
});
