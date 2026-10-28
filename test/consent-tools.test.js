import { describe, it, expect, vi } from 'vitest';
import { createConsentHandlers, formatPendingList, formatPendingAsk, formatConsentNudge, formatDecideAck, formatJournalConsentError } from '../lib/consent-tools.js';
import { createConsentClient } from '../lib/consent-client.js';

const NOW = 1_790_000_000_000;
const spawnAsk = { kind: 'spawn', id: 'sp-1', created_at: NOW - 5 * 60_000, from_device_id: 7, from_name: 'coord-box', from_convo_id: 'c-coord', from_convo_title: 'Coordinator', target_device_id: 12, target_name: 'elm', target_state: 'asleep', workdir: '/home/alice/proj', task: 'fix the flaky test\nand report back', topic: 'flaky test', model: 'opus[1m]', link: true, mission_num: 61, item_num: 640 };
const chatAsk = { kind: 'chat', id: 'room-1/12', created_at: NOW - 3 * 3_600_000, request: 'invite', room_id: 'room-1', room_title: 'A ↔ B', target_device_id: 12, from_device_id: 7, from_name: 'box-2', from_convo_id: 'c-2', from_convo_title: 'Dev 2', to_device_id: 12, to_name: 'elm', to_convo_id: 'c-e', to_convo_title: 'Eric session', target_state: 'online', topic: 'review', justification: 'need eyes on the diff' };

const TR_ID = `tr_${'a'.repeat(32)}`;
const transferAsk = { kind: 'transfer', id: TR_ID, created_at: NOW - 10 * 60_000, from_device_id: 7, from_name: 'box-a', from_convo_id: 'c-a', from_convo_title: 'Migration', room_id: 'room-1', room_title: 'A ↔ B', to_names: ['box-b'], name: 'staging.sql.gz', size: 1610612736, sha256: 'ab'.repeat(32), scan_verdict: 'not_scanned', scan_findings: [], reason: 'the staging dump\nfor the migration test', item_num: 650 };

function fixture({ coordinator = true, pending = { status: 200, data: { pending: [spawnAsk, chatAsk] } }, answer = { status: 200, data: { ok: true } } } = {}) {
  const session = { roomId: '!r:s', coordinator, journalConvoId: 'c-coord' };
  const sessions = new Map([['!r:s', session]]);
  const client = { pending: vi.fn(async () => pending), answer: vi.fn(async () => answer) };
  const h = createConsentHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, now: () => NOW });
  return { h, client, session };
}

describe('consent handlers', () => {
  it('refuse a non-Coordinator session before any journal call, and the usual session guards', async () => {
    const { h, client } = fixture({ coordinator: false });
    const r = await h.list({ roomId: '!r:s' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("only the Coordinator may answer consent asks on the user's behalf — this conversation is not the Coordinator");
    expect((await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'x', decision: 'approve', reason: 'r' })).status).toBe(403);
    expect(client.pending).not.toHaveBeenCalled();
    expect(client.answer).not.toHaveBeenCalled();
    expect((await h.list({})).status).toBe(400);
    expect((await h.list({ roomId: '!other' })).status).toBe(404);
    const noConvo = fixture();
    noConvo.session.journalConvoId = null;
    expect((await noConvo.h.list({ roomId: '!r:s' })).status).toBe(409);
  });

  it('isCoordinator lets the wiring count the journal\'s current role holder, so a live assignment is not refused', async () => {
    const session = { roomId: '!r:s', coordinator: false, journalConvoId: 'c-coord' };
    const sessions = new Map([['!r:s', session]]);
    const client = { pending: vi.fn(async () => ({ status: 200, data: { pending: [] } })), answer: vi.fn() };
    const h = createConsentHandlers({ sessions, journalConvoIdFor: (s) => s.journalConvoId, client, isCoordinator: (s, convoId) => s.coordinator === true || convoId === 'c-coord' });
    expect((await h.list({ roomId: '!r:s' })).status).toBe(200);
    session.journalConvoId = 'c-other';
    expect((await h.list({ roomId: '!r:s' })).status).toBe(403);
  });

  it('list asks the journal with the Coordinator convo id and passes the pending rows through', async () => {
    const { h, client } = fixture();
    const r = await h.list({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(client.pending.mock.calls[0]).toEqual(['c-coord']);
    expect(r.body.pending).toHaveLength(2);
    const old = fixture({ pending: { status: 404, data: { error: 'not_found' } } });
    expect((await old.h.list({ roomId: '!r:s' })).body.error).toMatch(/no \/consent routes yet/);
    const down = fixture({ pending: { status: 0, data: { error: 'journal unreachable' } } });
    expect((await down.h.list({ roomId: '!r:s' })).status).toBe(502);
  });

  it('decide validates kind, id, decision and reason, folds the reason to one line, and posts convo_id with it', async () => {
    const { h, client } = fixture();
    expect((await h.decide({ roomId: '!r:s', kind: 'mail', id: 'x', decision: 'approve', reason: 'r' })).status).toBe(400);
    expect((await h.decide({ roomId: '!r:s', kind: 'spawn', id: '', decision: 'approve', reason: 'r' })).status).toBe(400);
    expect((await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'x', decision: 'maybe', reason: 'r' })).status).toBe(400);
    expect((await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'x', decision: 'approve', reason: '  ' })).status).toBe(400);
    expect((await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'x', decision: 'approve', reason: 'x'.repeat(201) })).status).toBe(400);
    expect(client.answer).not.toHaveBeenCalled();
    const r = await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'sp-1', decision: 'approve', reason: ' follows the\nbox rules ' });
    expect(r.status).toBe(200);
    expect(client.answer.mock.calls[0]).toEqual([{ convo_id: 'c-coord', kind: 'spawn', id: 'sp-1', decision: 'approve', reason: 'follows the box rules' }]);
  });

  it('decide accepts kind "transfer" and posts it as is', async () => {
    const { h, client } = fixture();
    const r = await h.decide({ roomId: '!r:s', kind: 'transfer', id: TR_ID, decision: 'decline', reason: 'not part of any open mission' });
    expect(r.status).toBe(200);
    expect(client.answer.mock.calls[0]).toEqual([{ convo_id: 'c-coord', kind: 'transfer', id: TR_ID, decision: 'decline', reason: 'not part of any open mission' }]);
  });

  it('renders the transfer refusals: a flagged scan and a user-only box are the user\'s', async () => {
    const flagged = fixture({ answer: { status: 403, data: { error: 'forbidden', detail: 'secret_scan_flagged' } } });
    const r = await flagged.h.decide({ roomId: '!r:s', kind: 'transfer', id: TR_ID, decision: 'approve', reason: 'ok' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/secret scan flagged .*only the user may approve it.*decline with a reason is still allowed/);
    const userOnly = fixture({ answer: { status: 403, data: { error: 'forbidden', detail: 'user_only' } } });
    expect((await userOnly.h.decide({ roomId: '!r:s', kind: 'transfer', id: TR_ID, decision: 'approve', reason: 'ok' })).body.error).toMatch(/only the user may approve/);
    expect(formatJournalConsentError({ error: 'bad_request' })).toMatch(/kind is chat, spawn or transfer/);
    const own = fixture({ answer: { status: 403, data: { error: 'forbidden', detail: 'own_ask_unverified', why: "a file the Coordinator sends is the user's to approve" } } });
    expect((await own.h.decide({ roomId: '!r:s', kind: 'transfer', id: TR_ID, decision: 'approve', reason: 'ok' })).body.error)
      .toBe("a file your own session sends needs the user's own approval (why: a file the Coordinator sends is the user's to approve) — leave it for the user");
    // The spawn and chat wording is unchanged.
    expect(formatJournalConsentError({ error: 'forbidden', detail: 'own_ask_unverified' }, { kind: 'spawn' })).toMatch(/^the journal cannot tie your own request/);
  });

  it('a file from work the Coordinator relayed, with the user\'s file switch off, names the switch', () => {
    const why = "a file the Coordinator had another session send is the user's to approve while Coordinator file approvals are off";
    expect(formatJournalConsentError({ error: 'forbidden', detail: 'own_ask_unverified', why }, { kind: 'transfer' }))
      .toBe('this file comes from work you relayed (a carry-on, room message or spawn of yours), and the user has not switched on "Let the Coordinator approve file transfers" — leave it for the user');
  });

  it('the transfer cap is named as the cap on file approvals', () => {
    expect(formatJournalConsentError({ error: 'conflict', detail: 'daily_cap', cap: 100 }, { kind: 'transfer' }))
      .toBe('the daily cap on Coordinator file approvals is reached (100 in 24 h) — the file stays for the user; tell them in one line');
    expect(formatJournalConsentError({ error: 'conflict', detail: 'daily_cap', cap: 20 }, { kind: 'spawn' })).toMatch(/^the daily cap on Coordinator approvals is reached \(20 in 24 h\)/);
  });

  it('renders every journal refusal as a sentence that names the next move', async () => {
    const cases = [
      [{ status: 403, data: { error: 'forbidden', detail: 'not_coordinator' } }, /does not list this conversation as the Coordinator/],
      [{ status: 403, data: { error: 'forbidden', detail: 'consent_disabled' } }, /switched off .*leave this ask for them/],
      [{ status: 409, data: { error: 'conflict', detail: 'daily_cap', cap: 20 } }, /daily cap .*\(20 in 24 h\).*stays for the user/],
      [{ status: 409, data: { error: 'conflict', detail: 'target_offline' } }, /offline and cannot be woken.*decline with a reason is still allowed/],
      [{ status: 409, data: { error: 'conflict' } }, /no longer waiting/],
      [{ status: 404, data: { error: 'not_found' } }, /no such ask/],
      [{ status: 400, data: { error: 'bad_request' } }, /reason is 1–200 characters/],
    ];
    for (const [answer, re] of cases) {
      const { h } = fixture({ answer });
      const r = await h.decide({ roomId: '!r:s', kind: 'chat', id: 'room-1/12', decision: 'approve', reason: 'ok' });
      expect(r.status).toBe(answer.status);
      expect(r.body.error).toMatch(re);
    }
    expect(formatJournalConsentError({ error: 'weird' })).toBe('weird');
    const down = fixture({ answer: { status: 0, data: { error: 'journal unreachable' } } });
    expect((await down.h.decide({ roomId: '!r:s', kind: 'chat', id: 'room-1/12', decision: 'decline', reason: 'ok' })).status).toBe(502);
  });

  it('explains each refusal of an approval of the Coordinator\'s own ask, with the journal\'s why or cap', async () => {
    // The journal's one shape: the refusal code in detail, the reason in why, the cap in cap.
    const cases = [
      [{ status: 403, data: { error: 'forbidden', detail: 'own_ask_unverified', why: 'started by room_message' } }, "the journal cannot tie your own request to the user's words or a routine fire (why: started by room_message) — leave it for the user"],
      [{ status: 403, data: { error: 'forbidden', detail: 'envelope', why: 'spawns_per_fire 1 used' } }, "this request is outside the routine's envelope (spawns_per_fire 1 used) — leave it for the user or ask the user to widen the envelope"],
      [{ status: 403, data: { error: 'forbidden', detail: 'verifier', why: 'not a step of this routine' } }, "the verifier judged this request outside the routine's remit (not a step of this routine) — leave it for the user"],
      [{ status: 409, data: { error: 'conflict', detail: 'verifier_unavailable', why: 'no key' } }, 'the verifier could not run — the ask stays for the user'],
      [{ status: 409, data: { error: 'conflict', detail: 'routine_cap', cap: 10 } }, "routine-born approvals are at today's cap (10) — the ask stays for the user"],
    ];
    for (const [answer, text] of cases) {
      const { h } = fixture({ answer });
      const r = await h.decide({ roomId: '!r:s', kind: 'spawn', id: 'sp-1', decision: 'approve', reason: 'started by the user' });
      expect(r.status).toBe(answer.status);
      expect(r.body.error).toBe(text);
    }
    // Only that shape: a refusal code as the top-level error is not one of these.
    expect(formatJournalConsentError({ error: 'routine_cap', detail: '5' })).toBe('routine_cap');
    expect(formatJournalConsentError({ error: 'conflict', detail: 5 })).toMatch(/no longer waiting/);
    // No why: no empty parentheses; no cap: a question mark; peer-ish text one-lined and capped.
    expect(formatJournalConsentError({ error: 'forbidden', detail: 'own_ask_unverified' })).toBe("the journal cannot tie your own request to the user's words or a routine fire — leave it for the user");
    // A request relayed through another session names where it came from.
    expect(formatJournalConsentError({ error: 'forbidden', detail: 'own_ask_unverified', why: 'relayed from the Coordinator (carry_on:co_0123456789abcdef): started by room_message' }))
      .toBe("this request comes from your own carry-on, room message or spawn, and the journal cannot tie that to the user's words or a routine fire (why: relayed from the Coordinator (carry_on:co_0123456789abcdef): started by room_message) — leave it for the user");
    expect(formatJournalConsentError({ error: 'forbidden', detail: 'envelope' })).toBe("this request is outside the routine's envelope — leave it for the user or ask the user to widen the envelope");
    expect(formatJournalConsentError({ error: 'forbidden', detail: 'verifier' })).toBe("the verifier judged this request outside the routine's remit — leave it for the user");
    expect(formatJournalConsentError({ error: 'conflict', detail: 'routine_cap' })).toBe("routine-born approvals are at today's cap (?) — the ask stays for the user");
    const long = formatJournalConsentError({ error: 'forbidden', detail: 'verifier', why: 'a\nb'.repeat(400) });
    expect(long).not.toContain('\n');
    expect(long.length).toBeLessThan(500);
  });
});

describe('consent formatting', () => {
  it('formatPendingAsk: a spawn names asker, target box and state, directory, model, mission, room, task and the exact call, with peer text one-lined', () => {
    const text = formatPendingAsk(spawnAsk, { now: NOW });
    expect(text).toContain('spawn sp-1 (tracker #640) — 5 min ago: coord-box — session "Coordinator" [c-coord] asks to start a session on elm (box asleep)');
    expect(text).toContain('directory: /home/alice/proj · model: opus[1m] · joins mission #61 · opens a chat room back to the asker');
    expect(text).toContain('task: fix the flaky test ⏎ and report back');
    expect(text).toContain('consent_decide(kind: "spawn", id: "sp-1", decision: approve|decline, reason: …)');
    expect(text.split('\n')).toHaveLength(4);
  });
  it('formatPendingAsk: a no-model spawn onto a Fable-maxed box says it will run on Opus; a named model wins', () => {
    const { model: _, ...noModel } = spawnAsk;
    const text = formatPendingAsk({ ...noModel, fallback_model: 'opus', fallback_reason: 'fable_limit' }, { now: NOW });
    expect(text).toContain('directory: /home/alice/proj · model: opus — the box is at its Fable weekly limit · joins mission #61');
    const named = formatPendingAsk({ ...spawnAsk, fallback_model: 'opus', fallback_reason: 'fable_limit' }, { now: NOW });
    expect(named).toContain('· model: opus[1m] · joins');
    expect(named).not.toMatch(/Fable weekly limit/);
  });
  it('formatPendingAsk: a chat invite names both sides, the topic, the justification and the call; a join names the room', () => {
    const text = formatPendingAsk(chatAsk, { now: NOW });
    expect(text).toContain('chat room-1/12 — 3 h ago: box-2 — session "Dev 2" [c-2] asks to chat with elm — session "Eric session" about "review" (box online)');
    expect(text).toContain("why, in box-2's words: need eyes on the diff");
    expect(text).toContain('consent_decide(kind: "chat", id: "room-1/12", decision: approve|decline, reason: …)');
    const join = formatPendingAsk({ ...chatAsk, request: 'join', to_name: 'dev-a', room_title: 'triage' }, { now: NOW });
    expect(join).toContain('asks to join dev-a\'s room "triage"');
  });
  it('formatPendingAsk: one "started by" line per cause the bridge stamped, ref left out when absent; none without causes', () => {
    const causes = [{ kind: 'user_message', ref: 'c-coord:41', at: NOW - 60_000 }, { kind: 'routine', ref: 'routine:daily-sweep@1789999000000', at: NOW - 120_000 }, { kind: 'reminder', at: NOW }];
    const spawn = formatPendingAsk({ ...spawnAsk, causes }, { now: NOW }).split('\n');
    expect(spawn).toHaveLength(7);
    expect(spawn.slice(3, 6)).toEqual(['  started by: user_message c-coord:41', '  started by: routine routine:daily-sweep@1789999000000', '  started by: reminder']);
    expect(spawn[6]).toMatch(/^ {2}consent_decide\(kind: "spawn"/);
    const chat = formatPendingAsk({ ...chatAsk, causes: [{ kind: 'item_tap', ref: 'item:7@1789999000000', at: NOW }] }, { now: NOW }).split('\n');
    expect(chat).toHaveLength(4);
    expect(chat[2]).toBe('  started by: item_tap item:7@1789999000000');
    // Absent, empty or junk causes add nothing; peer text is one-lined.
    expect(formatPendingAsk({ ...spawnAsk, causes: [] }, { now: NOW })).toBe(formatPendingAsk(spawnAsk, { now: NOW }));
    expect(formatPendingAsk({ ...chatAsk, causes: 'user_message' }, { now: NOW })).toBe(formatPendingAsk(chatAsk, { now: NOW }));
    expect(formatPendingAsk({ ...chatAsk, causes: [null, { ref: 'x' }, { kind: 'room_message', ref: 'a\nb' }] }, { now: NOW })).toContain('  started by: room_message a ⏎ b');
  });
  it('formatPendingAsk: a transfer names sender, room and receivers, file, size, sha256 head, scan, note and the call', () => {
    const lines = formatPendingAsk(transferAsk, { now: NOW }).split('\n');
    expect(lines).toEqual([
      `transfer ${TR_ID} (tracker #650) — 10 min ago: box-a — session "Migration" [c-a] asks to send a file into room "A ↔ B", to box-b`,
      '  file: staging.sql.gz · 1.5 GB (1610612736 bytes) · sha256 abababababab…',
      '  secret scan: not scanned (binary or unsupported format)',
      "  note, in box-a's words: the staging dump ⏎ for the migration test",
      `  consent_decide(kind: "transfer", id: "${TR_ID}", decision: approve|decline, reason: …)`,
    ]);
    const clean = formatPendingAsk({ ...transferAsk, scan_verdict: 'clean', reason: '', to_names: [] }, { now: NOW });
    expect(clean).toContain('to no other box yet');
    expect(clean).toContain('  secret scan: clean');
    expect(clean).toContain('  note: (none) — never approve a transfer whose note does not explain it');
    expect(clean).not.toMatch(/only the user/);
    const userOnly = formatPendingAsk({ ...transferAsk, user_only: true }, { now: NOW });
    expect(userOnly).toContain('  only the user can approve this one: a box it involves is one only the user approves for — leave it for them, or decline with a reason');
    expect(userOnly).toContain(`consent_decide(kind: "transfer", id: "${TR_ID}", decision: decline, reason: …)`);
  });
  it('formatPendingAsk: a transfer shows its causes as chat and spawn asks do, after the note', () => {
    const lines = formatPendingAsk({ ...transferAsk, causes: [{ kind: 'user_message', ref: 'c-a:12' }, { kind: 'reminder' }] }, { now: NOW }).split('\n');
    expect(lines.slice(3, 6)).toEqual([
      "  note, in box-a's words: the staging dump ⏎ for the migration test",
      '  started by: user_message c-a:12',
      '  started by: reminder',
    ]);
    expect(formatPendingAsk(transferAsk, { now: NOW })).not.toContain('started by');
  });

  it('formatPendingAsk: a flagged transfer lists its findings and says the Coordinator cannot approve it', () => {
    const text = formatPendingAsk({ ...transferAsk, scan_verdict: 'flagged', scan_findings: [{ kind: 'aws_access_key', line: 3 }, { kind: 'private_key', line: 'db/keys.pem:1' }, { kind: 'x\ny', line: null }] }, { now: NOW });
    expect(text).toContain('  secret scan: flagged — 3 possible secrets: aws_access_key (line 3), private_key (db/keys.pem:1), x ⏎ y');
    expect(text).toContain('  flagged transfers cannot be approved by the Coordinator — leave it for the user, or decline with a reason');
    expect(text).toContain(`consent_decide(kind: "transfer", id: "${TR_ID}", decision: decline, reason: …)`);
    expect(text).not.toContain('approve|decline');
  });
  it('formatPendingList: empty, and a headed list; formatConsentNudge wraps one ask as a turn; formatDecideAck says what happened', () => {
    expect(formatPendingList({ pending: [] })).toBe('No chat, spawn or file transfer requests are waiting for approval.');
    const list = formatPendingList({ pending: [spawnAsk, chatAsk] }, { now: NOW });
    expect(list).toMatch(/^2 requests waiting for the user's approval \(oldest first\)/);
    expect(list).toContain('spawn sp-1');
    expect(list).toContain('chat room-1/12');
    const nudge = formatConsentNudge({ kind: 'consent', event: 'pending', ask: chatAsk }, { now: NOW });
    expect(nudge).toMatch(/^🤝 A consent request is waiting for the user:/);
    expect(nudge).toContain('chat room-1/12');
    expect(nudge).toContain('The user has the card too and may answer first.');
    expect(formatConsentNudge({ kind: 'consent', event: 'pending' })).toBeNull();
    expect(formatDecideAck({ ok: true }, { kind: 'spawn', decision: 'decline', id: 'sp-1' })).toMatch(/^Declined spawn request sp-1 on the user's behalf/);
    expect(formatDecideAck({ ok: true }, { kind: 'spawn', decision: 'approve', id: 'sp-1' })).toMatch(/^Approved spawn request sp-1 on the user's behalf — the session is being started/);
    expect(formatDecideAck({ ok: true, delivered: true }, { kind: 'chat', decision: 'approve', id: 'room-1/12' })).toMatch(/invitation was delivered/);
    expect(formatDecideAck({ ok: true, delivered: false }, { kind: 'chat', decision: 'approve', id: 'room-1/12' })).toMatch(/being woken/);
    expect(formatDecideAck({ ok: true }, { kind: 'transfer', decision: 'approve', id: TR_ID })).toMatch(/^Approved file transfer tr_a+ on the user's behalf — the file goes to the room once its upload is complete/);
    expect(formatDecideAck({ ok: true }, { kind: 'transfer', decision: 'decline', id: TR_ID })).toMatch(/^Declined file transfer tr_a+ on the user's behalf — the journal deletes the file/);
    const transferNudge = formatConsentNudge({ kind: 'consent', event: 'pending', ask: transferAsk }, { now: NOW });
    expect(transferNudge).toContain(`transfer ${TR_ID}`);
  });
});

describe('consent client', () => {
  it('GETs pending with the encoded convo id and POSTs the answer with the bearer token; never throws', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push([url, init]); return { ok: true, status: 200, json: async () => ({ pending: [] }) }; });
    const c = createConsentClient({ baseUrl: 'https://j/', token: 'T', fetchImpl });
    expect((await c.pending('a b')).status).toBe(200);
    expect(calls[0][0]).toBe('https://j/consent/pending?convo_id=a%20b');
    expect(calls[0][1].headers.Authorization).toBe('Bearer T');
    await c.answer({ convo_id: 'a', kind: 'spawn', id: 'x', decision: 'approve', reason: 'r' });
    expect(calls[1][0]).toBe('https://j/consent/answer');
    expect(JSON.parse(calls[1][1].body)).toEqual({ convo_id: 'a', kind: 'spawn', id: 'x', decision: 'approve', reason: 'r' });
    const broken = createConsentClient({ baseUrl: 'https://j', token: 'T', fetchImpl: async () => { throw new Error('boom'); } });
    expect(await broken.pending('a')).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const refused = createConsentClient({ baseUrl: 'https://j', token: 'T', fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'conflict', detail: 'daily_cap', cap: 20 }) }) });
    expect(await refused.answer({})).toEqual({ status: 409, data: { error: 'conflict', detail: 'daily_cap', cap: 20 } });
    expect((await createConsentClient({ baseUrl: '', token: 'T' }).pending('a')).status).toBe(0);
  });
});
