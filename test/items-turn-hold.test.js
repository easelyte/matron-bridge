import { describe, it, expect, vi } from 'vitest';
import { createItemTurnRouter, isTurnWorthy, isTranscriptionFollowUp, formatItemTurn } from '../lib/items-turn.js';

// The journal transcribes voice notes itself (matron-journal: "Journal-side
// transcription"): a `commented` marker with a pending audio attachment is
// HELD until the quiet `updated` follow-up brings the words.
const base = { item_id: 'it_1', num: 12, kind: 'question', title: 'Which auth?', by: 'user', awaiting: 'agent', resolution: null };
const audio = (over = {}) => ({ blob_ref: 'b1', mime: 'audio/mp4', name: 'v.m4a', size: 1, transcript: null, ...over });
const pending = (id = 'ic_1') => ({ ...base, action: 'commented', comment: { id, body: '', attachments: [audio({ transcript_status: 'pending' })] } });
const followUp = (id = 'ic_1', over = {}) => ({
  ...base, action: 'updated', transcription: 'done', for_action: 'commented',
  comment: { id, body: '', attachments: [audio({ transcript: 'use option A', transcript_status: 'done' })] }, ...over,
});
const failedFollowUp = (id = 'ic_1') => followUp(id, {
  transcription: 'failed', comment: { id, body: '', attachments: [audio({ transcript_status: 'failed' })] },
});

function harness(opts = {}) {
  const injected = [];
  const deps = {
    fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'audio/mp4' })),
    transcribe: vi.fn(async () => 'local whisper words'),
    injectBlocks: vi.fn((session, blocks) => { injected.push({ session, text: blocks[0].text }); return true; }),
    queueText: vi.fn(async () => {}),
    publishNotice: vi.fn(),
    setTranscript: vi.fn(async () => ({ status: 200 })),
    log: { warn: vi.fn() },
    ...opts,
  };
  return { route: createItemTurnRouter(deps), deps, injected };
}
const session = { journalConvoId: 'c1', busy: false };
const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await tick(); expect(cond()).toBe(true); };
// A journal wait the test releases by hand: the retry is in flight until then.
function deferredWait(answer) {
  let release;
  const gate = new Promise((r) => { release = () => r(answer); });
  return { fetchTranscript: vi.fn(() => gate), release };
}

describe('holding a turn for the journal transcript', () => {
  it('a follow-up is turn-worthy; a plain updated marker still is not', () => {
    expect(isTranscriptionFollowUp(followUp())).toBe(true);
    expect(isTurnWorthy(followUp())).toBe(true);
    expect(isTurnWorthy({ ...base, action: 'updated' })).toBe(false);
    expect(isTurnWorthy({ ...followUp(), for_action: 'reordered' })).toBe(false);
    expect(isTurnWorthy({ ...followUp(), comment: { body: '' } })).toBe(false);
    expect(formatItemTurn(followUp(), { username: 'alice' })).toContain('alice replied:\n[voice note v.m4a — transcript: use option A]');
  });

  it('holds the pending marker, then delivers ONE turn with the journal words and no local whisper', async () => {
    const { route, deps, injected } = harness();
    const run = route(session, { payload: pending() }, { username: 'alice' });
    await tick();
    expect(injected).toHaveLength(0);
    const fresh = { journalConvoId: 'c1', busy: false, fresh: true };
    await route(fresh, { payload: followUp() }, { username: 'alice' });
    await run;
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('📌 Item #12 "Which auth?" — alice replied:');
    expect(injected[0].text).toContain('transcript: use option A');
    expect(injected[0].session).toBe(fresh); // the session resolved at release time
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.setTranscript).not.toHaveBeenCalled();
  });

  it('failed follow-up, retry fails, local whisper available → local transcribe, PATCH once', async () => {
    // The journal's retry route is missing (an older journal: 404 -> null),
    // so this box's own whisper — installed here — is the fallback.
    const requestTranscript = vi.fn(async () => null);
    const { route, deps, injected } = harness({ requestTranscript, fetchTranscript: vi.fn(), hasLocalWhisper: () => true });
    const run = route(session, { payload: pending() }, { username: 'alice' });
    await tick();
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    await run;
    expect(requestTranscript).toHaveBeenCalledWith('b1');
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('transcript: local whisper words');
    expect(deps.transcribe).toHaveBeenCalledOnce();
    expect(deps.setTranscript).toHaveBeenCalledOnce();
    expect(deps.setTranscript).toHaveBeenCalledWith('it_1', 'ic_1', { blob_ref: 'b1', transcript: 'local whisper words' });
  });

  it('failed follow-up, the retry fails too, local whisper available → local transcribe after ONE wait', async () => {
    // A box with whisper gives the journal one wait, not two: it can do the
    // job itself (the same rule as a chat voice note).
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const fetchTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps, injected } = harness({ requestTranscript, fetchTranscript, hasLocalWhisper: () => true });
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    expect(fetchTranscript).toHaveBeenCalledOnce();
    expect(fetchTranscript).toHaveBeenCalledWith('b1', { waitS: 30 });
    expect(deps.transcribe).toHaveBeenCalledOnce();
    expect(deps.setTranscript).toHaveBeenCalledOnce();
    expect(injected[0].text).toContain('transcript: local whisper words');
  });

  it('failed follow-up → retry → journal words PATCHed back once, local transcribe not called', async () => {
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const fetchTranscript = vi.fn(async () => ({ status: 'done', transcript: '  use option B  ' }));
    // Local whisper IS installed: the journal's words still win, so it never runs.
    const { route, deps, injected } = harness({ requestTranscript, fetchTranscript, hasLocalWhisper: () => true });
    const run = route(session, { payload: pending() }, { username: 'alice' });
    await tick();
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    await run;
    expect(requestTranscript).toHaveBeenCalledOnce();
    expect(requestTranscript).toHaveBeenCalledWith('b1');
    expect(fetchTranscript).toHaveBeenCalledWith('b1', { waitS: 30 });
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.fetchMedia).not.toHaveBeenCalled();
    expect(deps.setTranscript).toHaveBeenCalledOnce();
    expect(deps.setTranscript).toHaveBeenCalledWith('it_1', 'ic_1', { blob_ref: 'b1', transcript: 'use option B' });
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('[voice note v.m4a — transcript: use option B]');
  });

  it('failed follow-up, retry fails, no local whisper → "(transcription failed)" and no PATCH', async () => {
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const fetchTranscript = vi.fn(async () => ({ status: 'failed' }));
    const { route, deps, injected } = harness({ requestTranscript, fetchTranscript });
    const run = route(session, { payload: pending() }, { username: 'alice' });
    await tick();
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    await run;
    expect(requestTranscript).toHaveBeenCalledOnce();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.fetchMedia).not.toHaveBeenCalled();
    expect(deps.setTranscript).not.toHaveBeenCalled();
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('[voice note v.m4a — (transcription failed)]');
  });

  it('a queued retry whose wait GET comes back empty (journal restarted) is busy, not absent', async () => {
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const fetchTranscript = vi.fn(async () => null);
    const { route, deps, injected } = harness({ requestTranscript, fetchTranscript });
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    expect(fetchTranscript).toHaveBeenCalledOnce();
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('journal: busy'));
    expect(deps.log.warn).not.toHaveBeenCalledWith(expect.stringContaining('journal: absent'));
    expect(injected[0].text).toContain('[voice note v.m4a — (transcription failed)]');
    expect(deps.setTranscript).not.toHaveBeenCalled();
  });

  it('no local whisper: a retry still pending is waited on twice, then the turn goes out without words', async () => {
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const fetchTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps, injected } = harness({ requestTranscript, fetchTranscript });
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    expect(fetchTranscript).toHaveBeenCalledTimes(2);
    expect(fetchTranscript.mock.calls.every((c) => c[0] === 'b1' && c[1]?.waitS === 30)).toBe(true);
    expect(deps.setTranscript).not.toHaveBeenCalled();
    expect(injected[0].text).toContain('(transcription failed)');
  });

  it('no local whisper: words on the second wait are delivered and PATCHed once', async () => {
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const fetchTranscript = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'done', transcript: 'slow words' });
    const { route, deps, injected } = harness({ requestTranscript, fetchTranscript });
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    expect(fetchTranscript).toHaveBeenCalledTimes(2);
    expect(deps.setTranscript).toHaveBeenCalledOnce();
    expect(injected[0].text).toContain('transcript: slow words');
  });

  it('a journal too busy to queue the retry is not waited on', async () => {
    const requestTranscript = vi.fn(async () => ({ status: 'none', reason: 'busy' }));
    const fetchTranscript = vi.fn();
    const { route, deps, injected } = harness({ requestTranscript, fetchTranscript });
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    expect(fetchTranscript).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(injected[0].text).toContain('(transcription failed)');
  });

  it('a journal done with no words and no local whisper writes nothing back and renders the empty marker', async () => {
    const requestTranscript = vi.fn(async () => ({ status: 'done', transcript: '   ' }));
    const { route, deps, injected } = harness({ requestTranscript, fetchTranscript: vi.fn() });
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.setTranscript).not.toHaveBeenCalled();
    expect(injected[0].text).toContain('[voice note v.m4a — (no transcript)]');
  });

  it('a retry that throws, and a hasLocalWhisper that throws, still deliver the turn', async () => {
    const requestTranscript = vi.fn(async () => { throw new Error('boom'); });
    const { route, deps, injected } = harness({ requestTranscript, hasLocalWhisper: () => { throw new Error('stat failed'); } });
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('(transcription failed)');
  });

  it('hold timeout → retry path, not immediate local whisper', async () => {
    // The journal's follow-up never came: ask it again before running
    // whisper here, even on a box that has whisper.
    const requestTranscript = vi.fn(async () => ({ status: 'done', transcript: 'late journal words' }));
    const fetchTranscript = vi.fn();
    const { route, deps, injected } = harness({ holdTimeoutMs: 20, requestTranscript, fetchTranscript, hasLocalWhisper: () => true });
    await route(session, { payload: pending() }, { username: 'alice' });
    expect(requestTranscript).toHaveBeenCalledWith('b1');
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.setTranscript).toHaveBeenCalledOnce();
    expect(deps.setTranscript).toHaveBeenCalledWith('it_1', 'ic_1', { blob_ref: 'b1', transcript: 'late journal words' });
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('transcript: late journal words');
    // A late follow-up is still not a second turn, nor a second write-back.
    await route(session, { payload: followUp() }, { username: 'alice' });
    expect(injected).toHaveLength(1);
    expect(deps.setTranscript).toHaveBeenCalledOnce();
  });

  it('a replayed frame or follow-up for a delivered comment never asks the journal again', async () => {
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const fetchTranscript = vi.fn(async () => ({ status: 'done', transcript: 'retry words' }));
    // A long hold: a replayed `commented` frame that waited would time the test out.
    const { route, deps, injected } = harness({ requestTranscript, fetchTranscript, holdTimeoutMs: 60_000 });
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    expect(injected).toHaveLength(1);
    expect(requestTranscript).toHaveBeenCalledOnce();
    await route(session, { payload: failedFollowUp() }, { username: 'alice' });
    await route(session, { payload: pending() }, { username: 'alice' });
    expect(requestTranscript).toHaveBeenCalledOnce();
    expect(fetchTranscript).toHaveBeenCalledOnce();
    expect(deps.setTranscript).toHaveBeenCalledOnce();
    expect(injected).toHaveLength(1);
  });

  it('hold timeout, retry pending, the journal follow-up lands during the wait: one turn, one write-back', async () => {
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { fetchTranscript, release } = deferredWait({ status: 'done', transcript: 'retry words' });
    const { route, deps, injected } = harness({ holdTimeoutMs: 20, requestTranscript, fetchTranscript });
    const run = route(session, { payload: pending() }, { username: 'alice' });
    await until(() => fetchTranscript.mock.calls.length === 1);
    // The follow-up comes after the hold gave up, while the retry is waiting.
    const late = route(session, { payload: followUp() }, { username: 'alice' });
    await tick();
    expect(injected).toHaveLength(0);
    release();
    await Promise.all([run, late]);
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('transcript: retry words');
    expect(deps.setTranscript.mock.calls.length).toBeLessThanOrEqual(1);
    expect(requestTranscript).toHaveBeenCalledOnce();
  });

  it('a typed reply behind a held-then-retrying note is delivered after it, in marker order', async () => {
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { fetchTranscript, release } = deferredWait({ status: 'done', transcript: 'the note' });
    const { route, injected } = harness({ holdTimeoutMs: 20, requestTranscript, fetchTranscript });
    const a = route(session, { payload: pending('ic_a') }, { username: 'alice' });
    const c = route(session, { payload: { ...base, action: 'commented', comment: { id: 'ic_c', body: 'typed', attachments: [] } } }, { username: 'alice' });
    await until(() => fetchTranscript.mock.calls.length === 1);
    await tick();
    expect(injected).toHaveLength(0);
    release();
    await Promise.all([a, c]);
    expect(injected.map((i) => i.text.split('\n')[1])).toEqual(['[voice note v.m4a — transcript: the note]', 'typed']);
  });

  it('no follow-up in time and no journal answer: falls back to local whisper, and a late follow-up is not a second turn', async () => {
    const { route, deps, injected } = harness({ holdTimeoutMs: 20, hasLocalWhisper: () => true });
    await route(session, { payload: pending() }, { username: 'alice' });
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('transcript: local whisper words');
    expect(deps.log.warn).toHaveBeenCalled();
    await route(session, { payload: followUp() }, { username: 'alice' });
    expect(injected).toHaveLength(1);
  });

  it('timeout path delivers to the conversation\'s CURRENT session; a failed hand-over is not remembered as delivered', async () => {
    const current = { journalConvoId: 'c1', busy: false, current: true };
    const h = harness({ holdTimeoutMs: 10, resolveSession: vi.fn(() => current) });
    await h.route(session, { payload: pending() }, { username: 'alice' });
    expect(h.injected[0].session).toBe(current);

    const refuse = harness({ holdTimeoutMs: 10, injectBlocks: vi.fn(() => false) });
    await refuse.route(session, { payload: pending('ic_9') }, { username: 'alice' });
    expect(refuse.deps.publishNotice).toHaveBeenCalledOnce();
    refuse.deps.injectBlocks.mockImplementation(() => true);
    await refuse.route(session, { payload: followUp('ic_9') }, { username: 'alice' }); // replay gets its chance
    expect(refuse.deps.injectBlocks).toHaveBeenCalledTimes(2);
    // …and once delivered, a replayed `commented` frame neither waits nor repeats.
    await refuse.route(session, { payload: pending('ic_9') }, { username: 'alice' });
    expect(refuse.deps.injectBlocks).toHaveBeenCalledTimes(2);
  });

  it('a later reply waits behind the held turn (marker order), and a follow-up that beats its turn to the front still releases it', async () => {
    const { route, injected } = harness();
    const a = route(session, { payload: pending('ic_a') }, { username: 'alice' });
    const b = route(session, { payload: pending('ic_b') }, { username: 'alice' });
    const c = route(session, { payload: { ...base, action: 'commented', comment: { id: 'ic_c', body: 'typed', attachments: [] } } }, { username: 'alice' });
    await tick();
    // b's words arrive while b is still queued behind a.
    const early = route(session, { payload: followUp('ic_b', { comment: { id: 'ic_b', body: '', attachments: [audio({ transcript: 'second', transcript_status: 'done' })] } }) }, { username: 'alice' });
    await tick();
    expect(injected).toHaveLength(0);
    await route(session, { payload: followUp('ic_a') }, { username: 'alice' });
    await Promise.all([a, b, c, early]);
    expect(injected.map((i) => i.text.split('\n')[1])).toEqual([
      '[voice note v.m4a — transcript: use option A]', '[voice note v.m4a — transcript: second]', 'typed',
    ]);
  });

  it('a follow-up with no held turn (bridge restarted past the first marker) delivers on its own', async () => {
    const { route, injected } = harness();
    await route(session, { payload: followUp() }, { username: 'alice' });
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('alice replied:');
    await route(session, { payload: followUp() }, { username: 'alice' }); // replayed frame
    expect(injected).toHaveLength(1);
  });

  it('a voice note on a NEW item: the created turn is held, then leads with the item body and carries the words', async () => {
    const getItem = vi.fn(async () => ({ status: 200, data: { item: { body: 'see the note' } } }));
    const { route, injected } = harness({ getItem });
    const created = { ...base, kind: 'task', action: 'created', comment: { id: 'ic_b', body: '', attachments: [audio({ transcript_status: 'pending' })] } };
    const run = route(session, { payload: created }, { username: 'alice' });
    await tick();
    expect(injected).toHaveLength(0);
    await route(session, { payload: followUp('ic_b', { kind: 'task', for_action: 'created' }) }, { username: 'alice' });
    await run;
    expect(injected).toHaveLength(1);
    expect(injected[0].text.split('\n').slice(0, 3)).toEqual([
      '📌 alice filed a new task #12 "Which auth?":', 'see the note', '[voice note v.m4a — transcript: use option A]',
    ]);
  });

  it('a journal without whisper (no status field) behaves exactly as before on a box with whisper', async () => {
    const { route, deps, injected } = harness({ hasLocalWhisper: () => true });
    await route(session, { payload: { ...base, action: 'commented', comment: { id: 'ic_1', body: '', attachments: [audio()] } } }, { username: 'alice' });
    expect(injected).toHaveLength(1);
    expect(deps.transcribe).toHaveBeenCalledOnce();
  });

  it('a box without whisper never fetches or transcribes the audio itself', async () => {
    const { route, deps, injected } = harness();
    await route(session, { payload: { ...base, action: 'commented', comment: { id: 'ic_1', body: '', attachments: [audio()] } } }, { username: 'alice' });
    expect(injected).toHaveLength(1);
    expect(deps.fetchMedia).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.setTranscript).not.toHaveBeenCalled();
    expect(injected[0].text).toContain('(transcription failed)');
  });
});
