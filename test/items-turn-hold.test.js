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

describe('holding a turn for the journal transcript', () => {
  it('a follow-up is turn-worthy; a plain updated marker still is not', () => {
    expect(isTranscriptionFollowUp(followUp())).toBe(true);
    expect(isTurnWorthy(followUp())).toBe(true);
    expect(isTurnWorthy({ ...base, action: 'updated' })).toBe(false);
    expect(isTurnWorthy({ ...followUp(), for_action: 'reordered' })).toBe(false);
    expect(isTurnWorthy({ ...followUp(), comment: { body: '' } })).toBe(false);
    expect(formatItemTurn(followUp(), { username: 'dan' })).toContain('dan replied:\n[voice note v.m4a — transcript: use option A]');
  });

  it('holds the pending marker, then delivers ONE turn with the journal words and no local whisper', async () => {
    const { route, deps, injected } = harness();
    const run = route(session, { payload: pending() }, { username: 'dan' });
    await tick();
    expect(injected).toHaveLength(0);
    const fresh = { journalConvoId: 'c1', busy: false, fresh: true };
    await route(fresh, { payload: followUp() }, { username: 'dan' });
    await run;
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('📌 Item #12 "Which auth?" — dan replied:');
    expect(injected[0].text).toContain('transcript: use option A');
    expect(injected[0].session).toBe(fresh); // the session resolved at release time
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.setTranscript).not.toHaveBeenCalled();
  });

  it('on transcription:failed the turn is released and this bridge tries its own whisper', async () => {
    const { route, deps, injected } = harness();
    const run = route(session, { payload: pending() }, { username: 'dan' });
    await tick();
    await route(session, { payload: followUp('ic_1', { transcription: 'failed', comment: { id: 'ic_1', body: '', attachments: [audio({ transcript_status: 'failed' })] } }) }, { username: 'dan' });
    await run;
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('transcript: local whisper words');
    expect(deps.setTranscript).toHaveBeenCalledOnce();
  });

  it('no follow-up in time: falls back to local whisper, and a late follow-up is not a second turn', async () => {
    const { route, deps, injected } = harness({ holdTimeoutMs: 20 });
    await route(session, { payload: pending() }, { username: 'dan' });
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('transcript: local whisper words');
    expect(deps.log.warn).toHaveBeenCalled();
    await route(session, { payload: followUp() }, { username: 'dan' });
    expect(injected).toHaveLength(1);
  });

  it('timeout path delivers to the conversation\'s CURRENT session; a failed hand-over is not remembered as delivered', async () => {
    const current = { journalConvoId: 'c1', busy: false, current: true };
    const h = harness({ holdTimeoutMs: 10, resolveSession: vi.fn(() => current) });
    await h.route(session, { payload: pending() }, { username: 'dan' });
    expect(h.injected[0].session).toBe(current);

    const refuse = harness({ holdTimeoutMs: 10, injectBlocks: vi.fn(() => false) });
    await refuse.route(session, { payload: pending('ic_9') }, { username: 'dan' });
    expect(refuse.deps.publishNotice).toHaveBeenCalledOnce();
    refuse.deps.injectBlocks.mockImplementation(() => true);
    await refuse.route(session, { payload: followUp('ic_9') }, { username: 'dan' }); // replay gets its chance
    expect(refuse.deps.injectBlocks).toHaveBeenCalledTimes(2);
    // …and once delivered, a replayed `commented` frame neither waits nor repeats.
    await refuse.route(session, { payload: pending('ic_9') }, { username: 'dan' });
    expect(refuse.deps.injectBlocks).toHaveBeenCalledTimes(2);
  });

  it('a later reply waits behind the held turn (marker order), and a follow-up that beats its turn to the front still releases it', async () => {
    const { route, injected } = harness();
    const a = route(session, { payload: pending('ic_a') }, { username: 'dan' });
    const b = route(session, { payload: pending('ic_b') }, { username: 'dan' });
    const c = route(session, { payload: { ...base, action: 'commented', comment: { id: 'ic_c', body: 'typed', attachments: [] } } }, { username: 'dan' });
    await tick();
    // b's words arrive while b is still queued behind a.
    const early = route(session, { payload: followUp('ic_b', { comment: { id: 'ic_b', body: '', attachments: [audio({ transcript: 'second', transcript_status: 'done' })] } }) }, { username: 'dan' });
    await tick();
    expect(injected).toHaveLength(0);
    await route(session, { payload: followUp('ic_a') }, { username: 'dan' });
    await Promise.all([a, b, c, early]);
    expect(injected.map((i) => i.text.split('\n')[1])).toEqual([
      '[voice note v.m4a — transcript: use option A]', '[voice note v.m4a — transcript: second]', 'typed',
    ]);
  });

  it('a follow-up with no held turn (bridge restarted past the first marker) delivers on its own', async () => {
    const { route, injected } = harness();
    await route(session, { payload: followUp() }, { username: 'dan' });
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('dan replied:');
    await route(session, { payload: followUp() }, { username: 'dan' }); // replayed frame
    expect(injected).toHaveLength(1);
  });

  it('a voice note on a NEW item: the created turn is held, then leads with the item body and carries the words', async () => {
    const getItem = vi.fn(async () => ({ status: 200, data: { item: { body: 'see the note' } } }));
    const { route, injected } = harness({ getItem });
    const created = { ...base, kind: 'task', action: 'created', comment: { id: 'ic_b', body: '', attachments: [audio({ transcript_status: 'pending' })] } };
    const run = route(session, { payload: created }, { username: 'dan' });
    await tick();
    expect(injected).toHaveLength(0);
    await route(session, { payload: followUp('ic_b', { kind: 'task', for_action: 'created' }) }, { username: 'dan' });
    await run;
    expect(injected).toHaveLength(1);
    expect(injected[0].text.split('\n').slice(0, 3)).toEqual([
      '📌 dan filed a new task #12 "Which auth?":', 'see the note', '[voice note v.m4a — transcript: use option A]',
    ]);
  });

  it('a journal without whisper (no status field) behaves exactly as before', async () => {
    const { route, deps, injected } = harness();
    await route(session, { payload: { ...base, action: 'commented', comment: { id: 'ic_1', body: '', attachments: [audio()] } } }, { username: 'dan' });
    expect(injected).toHaveLength(1);
    expect(deps.transcribe).toHaveBeenCalledOnce();
  });
});
