import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { armReplyRef, settleReplyRef } from '../lib/journal-stream.js';
import { summaryWindow, buildSummaryPrompt, splitSpoken, spokenPayload, spokenRefFor } from '../lib/summary-pass.js';
import { parseTitlePassResponse, withSessionShort, titleMarkerFor } from '../lib/journal-title-seed.js';

// The spoken summary (voice mode, matron-apple spec 2026-10-03 §1) as index.js
// wires it. Importing index.js would start the bridge, so the two functions
// under test are lifted out of its source and run in a vm with their
// collaborators stubbed — the idiom of test/codex-progress.test.js. The
// pieces themselves are tested in test/journal-stream.test.js and
// test/summary-pass.test.js; a break here is silent in production (voice mode
// just loses its spoken line and falls back to the apps' own cleaner).
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

// Runs the real flushResponse once.
function flushWith(session, { splitMessage = (text) => [text] } = {}) {
  const start = src.indexOf('function flushResponse(');
  const end = src.indexOf('\n}\n', start) + 2;
  expect(start, 'could not find flushResponse in index.js — this test needs updating').toBeGreaterThan(-1);
  const context = vm.createContext({
    briefContextReport: () => null,
    recordConversationMessage: (s, role, text) => s.chatHistory.push({ role, text }),
    applyFallbackTitle: () => {}, SERVER_LABEL: 'bridge', updateRoomName: () => {},
    splitMessage, armReplyRef, settleReplyRef,
  });
  vm.runInContext(src.slice(start, end), context);
  context.flushResponse(session);
}

// A session whose sendCallback stands in for sendToRoom: it puts the armed
// ref on the text event it "publishes" and nulls it, in the same synchronous
// step. `events` is what was published.
function sessionWith(extra = {}) {
  const events = [];
  const session = {
    responseBuffer: 'The fix is ready.', chatHistory: [], _journalStreamRef: null, _journalDurableRef: null,
    sendCallback: (body) => {
      const ref = session._journalDurableRef;
      session._journalDurableRef = null;
      events.push(ref ? { body, message_ref: ref } : { body });
    },
    ...extra,
  };
  return { session, events };
}

describe('reply ref wiring (flushResponse)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('a reply that was never streamed is published under a fresh ref, and the session remembers it', () => {
    const { session, events } = sessionWith();
    flushWith(session);
    expect(events).toHaveLength(1);
    expect(events[0].body).toBe('The fix is ready.');
    expect(events[0].message_ref).toMatch(UUID);
    expect(session._lastReplyRef).toBe(events[0].message_ref);
    expect(session._journalDurableRef).toBeNull();
  });

  it('a streamed reply keeps its overlay ref, and the session remembers that one', () => {
    const { session, events } = sessionWith({ _journalStreamRef: 'msg_A' });
    flushWith(session);
    expect(events).toEqual([{ body: 'The fix is ready.', message_ref: 'msg_A' }]);
    expect(session._lastReplyRef).toBe('msg_A');
  });

  it('a reply split into chunks carries the ref on its first chunk only', () => {
    const { session, events } = sessionWith({ _journalStreamRef: 'msg_A', responseBuffer: 'one two' });
    flushWith(session, { splitMessage: (text) => text.split(' ') });
    expect(events).toEqual([{ body: 'one', message_ref: 'msg_A' }, { body: 'two' }]);
    expect(session._lastReplyRef).toBe('msg_A');
  });

  it('each flush replaces the remembered ref: the last reply of the turn wins', () => {
    const { session, events } = sessionWith();
    flushWith(session);
    session.responseBuffer = 'Shall I deploy it?';
    flushWith(session);
    expect(events).toHaveLength(2);
    expect(events[1].message_ref).not.toBe(events[0].message_ref);
    expect(session._lastReplyRef).toBe(events[1].message_ref);
  });

  it('a reply that is only a code block is published with its ref but not remembered: the summary pass never saw it', () => {
    // flushResponse keeps code-only replies out of chatHistory, so the summary
    // model cannot have written about one. Remembering its ref would hang a
    // spoken line about an earlier reply on this one.
    const { session, events } = sessionWith({ _lastReplyRef: 'msg_OLD', responseBuffer: '```sh\nls\n```' });
    flushWith(session);
    expect(events).toHaveLength(1);
    expect(events[0].message_ref).toMatch(UUID);
    expect(session.chatHistory).toEqual([]);
    expect(session._lastReplyRef).toBeNull();
  });

  it('a callback that does not publish through sendToRoom leaves nothing armed and nothing remembered', () => {
    const received = [];
    const { session } = sessionWith({ _lastReplyRef: 'msg_OLD' });
    session.sendCallback = (body) => received.push(body);
    flushWith(session);
    expect(received).toEqual(['The fix is ready.']);
    expect(session._journalDurableRef).toBeNull();
    expect(session._lastReplyRef).toBeNull();
  });
});

// maybeUpdatePinnedSummary is run for real too, with the model and the journal
// stubbed: `answer` is what the model returns, and the result is every journal
// publish the pass made. `during` runs while the model call is in flight.
async function runPass(session, answer, { during } = {}) {
  const start = src.indexOf('async function maybeUpdatePinnedSummary(');
  const end = src.indexOf('\n}\n', start) + 2;
  expect(start, 'could not find maybeUpdatePinnedSummary in index.js — this test needs updating').toBeGreaterThan(-1);
  const published = [];
  const context = vm.createContext({
    applyFallbackTitle: () => {}, SERVER_LABEL: 'bridge', updateRoomName: () => {},
    llmTitleEarned: () => false, markLlmTitleEarned: () => {},
    // The event names the model that wrote this pass's text (returned with
    // it), never the shared configuration label.
    summaryModel: {
      model: 'configured-label',
      generate: async () => { during?.(); return answer; },
      generateWithModel: async () => { during?.(); return { text: answer, model: 'test-model' }; },
    },
    summaryModelNag: { maybeFile: () => {} },
    journalConvoIdFor: () => 'convo', debug: () => {}, console,
    summaryWindow, buildSummaryPrompt, splitSpoken, spokenPayload, spokenRefFor,
    parseTitlePassResponse, withSessionShort, titleMarkerFor,
    journalUpsertConvo: () => {}, persistSession: () => {},
    // JSON round trip: the payload is built inside the vm, in another realm.
    journalPublish: (_session, method, payload) => published.push({ method, payload: JSON.parse(JSON.stringify(payload)) }),
  });
  vm.runInContext(src.slice(start, end), context);
  await context.maybeUpdatePinnedSummary(session);
  return published;
}

// A session whose turn has just ended: one user message, one reply, and the
// ref that reply's text event was published under.
function turnEnded(extra = {}) {
  return {
    roomId: 'room', claudeSessionId: 'ab12', workdir: '/tmp/w',
    chatHistory: [{ role: 'user', text: 'Fix the export.' }, { role: 'assistant', text: 'Fixed. Shall I deploy it?' }],
    pinnedSummaryText: '• Looked at the export.', lastSummaryMsgCount: 0, lastRosterText: '',
    _lastReplyRef: 'msg_A',
    ...extra,
  };
}

const ANSWER = [
  'TITLE: export fix',
  'NEW: Fixed the export.',
  'SPOKEN: The agent asks whether to deploy now. The export is fixed.',
  'SPOKEN_MORE: Deploying now puts it live tonight,',
  'before anyone has reviewed it.',
  'ROSTER: Fixing the nightly export.',
].join('\n');

describe('spoken summary wiring (maybeUpdatePinnedSummary)', () => {
  it('publishes one summary event carrying {toc, detail, model, spoken, spoken_more, spoken_ref}', async () => {
    const published = await runPass(turnEnded(), ANSWER);
    expect(published).toEqual([{
      method: 'publishSummary',
      payload: {
        toc: 'Fixed the export.',
        detail: 'Fixing the nightly export.',
        model: 'test-model',
        spoken: 'The agent asks whether to deploy now. The export is fixed.',
        spoken_more: 'Deploying now puts it live tonight, before anyone has reviewed it.',
        spoken_ref: 'msg_A',
      },
    }]);
    expect(Object.keys(published[0].payload)).toEqual(['toc', 'detail', 'model', 'spoken', 'spoken_more', 'spoken_ref']);
  });

  it('leaves spoken_more out when the model wrote NONE', async () => {
    const [{ payload }] = await runPass(turnEnded(), ANSWER.replace(/SPOKEN_MORE:[\s\S]*?\nROSTER/, 'SPOKEN_MORE: none\nROSTER'));
    expect(payload.spoken).toBe('The agent asks whether to deploy now. The export is fixed.');
    expect(payload.spoken_ref).toBe('msg_A');
    expect('spoken_more' in payload).toBe(false);
  });

  it('with no SPOKEN line the event is published exactly as before', async () => {
    const [{ payload }] = await runPass(turnEnded(), 'TITLE: export fix\nNEW: Fixed the export.\nROSTER: Fixing the nightly export.');
    expect(payload).toEqual({ toc: 'Fixed the export.', detail: 'Fixing the nightly export.', model: 'test-model' });
  });

  it('a turn in which the agent said nothing gets no spoken keys, whatever the model wrote', async () => {
    // Only a user message is new: _lastReplyRef still names the reply of an
    // EARLIER turn, and these lines must not be hung on it.
    const session = turnEnded({ lastSummaryMsgCount: 2 });
    session.chatHistory.push({ role: 'user', text: 'Actually, stop.' });
    const [{ payload }] = await runPass(session, ANSWER);
    expect(payload).toEqual({ toc: 'Fixed the export.', detail: 'Fixing the nightly export.', model: 'test-model' });
  });

  it('a reply whose text event carried no ref gets no spoken keys', async () => {
    const [{ payload }] = await runPass(turnEnded({ _lastReplyRef: null }), ANSWER);
    expect(payload).toEqual({ toc: 'Fixed the export.', detail: 'Fixing the nightly export.', model: 'test-model' });
  });

  it('a reply flushed while the model was answering does not lend its ref to this pass', async () => {
    const session = turnEnded();
    const [{ payload }] = await runPass(session, ANSWER, { during: () => { session._lastReplyRef = 'msg_LATER'; } });
    expect(payload.spoken_ref).toBe('msg_A');
  });

  it('cuts over-long lines to 400 and 1,200 characters', async () => {
    const long = (n) => Array.from({ length: n }, () => 'word').join(' ');
    const [{ payload }] = await runPass(turnEnded(), `NEW: n\nSPOKEN: ${long(200)}\nSPOKEN_MORE: ${long(400)}\nROSTER: r`);
    expect(payload.spoken.length).toBe(399); // 80 whole words
    expect(payload.spoken_more.length).toBe(1199); // 240 whole words
  });

  it('spoken prose never becomes the table-of-contents line (first pass, SUMMARY variant)', async () => {
    const answer = 'TITLE: export fix\nSUMMARY: Fixed the export.\nSPOKEN: Here is what is new: the export works.\nROSTER: Fixing the nightly export.';
    const [{ payload }] = await runPass(turnEnded({ pinnedSummaryText: '' }), answer);
    expect(payload.toc).toBe('Fixed the export.');
    expect(payload.spoken).toBe('Here is what is new: the export works.');
  });
});
