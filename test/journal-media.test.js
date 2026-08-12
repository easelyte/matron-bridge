import { describe, it, expect, vi } from 'vitest';
import { createJournalMediaRouter } from '../lib/journal-media.js';

const silentLog = { warn: () => {}, error: () => {} };

// Fully-injected orchestrator: every I/O boundary (fetchMedia, transcribe, the
// save/build + inject sinks) is a mock, so the fetch -> transcribe/save ->
// inject flow is exercised without a journal server, whisper, or a real claude
// session. The returned routeMedia is async and must never throw/reject.
function makeRouter(overrides = {}) {
  const deps = {
    fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('bytes'), contentType: 'application/pdf' })),
    transcribe: vi.fn(async () => 'hello world'),
    buildSavedBlocks: vi.fn(() => [{ type: 'text', text: 'File saved to /w/report.pdf' }]),
    injectText: vi.fn(() => true),
    injectBlocks: vi.fn(() => true),
    queueMedia: vi.fn(async () => {}),
    echoToRoom: vi.fn(),
    publishNotice: vi.fn(),
    escapeHtml: (s) => String(s),
    log: silentLog,
    ...overrides,
  };
  return { route: createJournalMediaRouter(deps), deps };
}

const session = { claudeSessionId: 'convo-1', roomId: '!r:s' };
const ctx = { username: 'dan' };

describe('createJournalMediaRouter — file/image', () => {
  it('fetches the blob and injects saved-media blocks WITHOUT re-mirroring (injectBlocks)', async () => {
    const { route, deps } = makeRouter();
    await route(session, { type: 'file', blobRef: 'blob-1', contentType: 'application/pdf', name: 'report.pdf' }, ctx);

    expect(deps.fetchMedia).toHaveBeenCalledWith('blob-1');
    expect(deps.buildSavedBlocks).toHaveBeenCalledTimes(1);
    const [, buildArgs] = deps.buildSavedBlocks.mock.calls[0];
    expect(buildArgs).toMatchObject({ mime: 'application/pdf', isImage: false, name: 'report.pdf' });
    expect(deps.injectBlocks).toHaveBeenCalledWith(session, [{ type: 'text', text: 'File saved to /w/report.pdf' }]);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it('passes the caption through to the block builder', async () => {
    // The caption is the whole point of staging attachments in the composer:
    // it has to survive the router hop or claude gets the picture with no
    // idea what was asked about it.
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('img'), contentType: 'image/png' })),
    });

    await route(session, {
      type: 'image', blobRef: 'img-1', contentType: 'image/png',
      name: 'x.png', caption: 'what breed is this?',
    }, ctx);

    const [, buildArgs] = deps.buildSavedBlocks.mock.calls[0];
    expect(buildArgs.caption).toBe('what breed is this?');
  });

  it('passes a null caption through for an attachment sent with no message', async () => {
    const { route, deps } = makeRouter();

    await route(session, {
      type: 'file', blobRef: 'blob-1', contentType: 'application/pdf', name: 'report.pdf',
    }, ctx);

    const [, buildArgs] = deps.buildSavedBlocks.mock.calls[0];
    expect(buildArgs.caption).toBeUndefined();
  });

  it('classifies type:image as an image for the block builder', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('img'), contentType: 'image/png' })),
      buildSavedBlocks: vi.fn(() => [{ type: 'text', text: 'Image saved to /w/x.png' }, { type: 'image', source: {} }]),
    });
    await route(session, { type: 'image', blobRef: 'img-1', contentType: 'image/png', name: 'x.png', dims: { w: 2, h: 3 } }, ctx);
    const [, buildArgs] = deps.buildSavedBlocks.mock.calls[0];
    expect(buildArgs).toMatchObject({ isImage: true, dims: { w: 2, h: 3 } });
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
  });

  it('awaits an ASYNC buildSavedBlocks (the inline-image downscale path returns a promise)', async () => {
    const blocks = [{ type: 'text', text: 'Image saved to /w/big.jpg' }, { type: 'image', source: {} }];
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('img'), contentType: 'image/jpeg' })),
      buildSavedBlocks: vi.fn(async () => blocks),
    });
    await route(session, { type: 'image', blobRef: 'img-2', contentType: 'image/jpeg', name: 'big.jpg' }, ctx);
    expect(deps.injectBlocks).toHaveBeenCalledWith(session, blocks);
  });

  it('uses the fetched content-type when the frame declared none', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'text/plain' })),
    });
    await route(session, { type: 'file', blobRef: 'b', contentType: null, name: 'n.txt' }, ctx);
    expect(deps.buildSavedBlocks.mock.calls[0][1].mime).toBe('text/plain');
  });

  it('a failed fetch (null) warns and drops — no inject, no placeholder', async () => {
    const warnings = [];
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => null),
      log: { warn: (...a) => warnings.push(a.join(' ')), error: () => {} },
    });
    await route(session, { type: 'file', blobRef: 'gone', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.buildSavedBlocks).not.toHaveBeenCalled();
    expect(warnings.some(w => /dropping/.test(w))).toBe(true);
    // The user must be told the attachment never reached claude — same as the
    // transcription-failure path — since the room already showed a success echo.
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/Couldn't fetch that attachment/));
  });

  it('a failed fetch labels the notice by declared kind (voice note / image)', async () => {
    const { route, deps } = makeRouter({ fetchMedia: vi.fn(async () => null) });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'audio/ogg', name: 'v.ogg' }, ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/Couldn't fetch that voice note/));

    deps.publishNotice.mockClear();
    await route(session, { type: 'image', blobRef: 'i', contentType: 'image/png', name: 'i.png' }, ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/Couldn't fetch that image/));
  });

  it('an empty block list is dropped (never injects an empty turn)', async () => {
    const { route, deps } = makeRouter({ buildSavedBlocks: vi.fn(() => []) });
    await route(session, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    expect(deps.injectBlocks).not.toHaveBeenCalled();
  });

  it('an attachment that produced no blocks notifies the user, naming the file (fail-visible, not a silent drop)', async () => {
    const { route, deps } = makeRouter({ buildSavedBlocks: vi.fn(() => []) });
    await route(session, {
      type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf', caption: 'look at this',
    }, ctx);
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/Couldn't deliver that attachment \(x\.pdf\)/));
  });

  it('an UNcaptioned attachment that produced no blocks also notifies — the room already showed a success echo', async () => {
    const { route, deps } = makeRouter({ buildSavedBlocks: vi.fn(() => []) });
    await route(session, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/Couldn't deliver that attachment \(x\.pdf\)/));
  });

  it('an image with no name that produced no blocks notices with the image label and no parenthetical', async () => {
    const { route, deps } = makeRouter({ buildSavedBlocks: vi.fn(() => []) });
    await route(session, { type: 'image', blobRef: 'i', contentType: 'image/png' }, ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', "Couldn't deliver that image to claude.");
  });

  it('an unavailable session (injectBlocks false) publishes an undeliverable notice', async () => {
    const { route, deps } = makeRouter({ injectBlocks: vi.fn(() => false) });
    await route(session, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/isn't available/));
  });

  it('never throws even when a dep throws — and notices the user', async () => {
    const { route, deps } = makeRouter({ buildSavedBlocks: vi.fn(() => { throw new Error('boom'); }) });
    await expect(route(session, { type: 'file', blobRef: 'b', contentType: 'application/pdf' }, ctx)).resolves.toBeUndefined();
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    // The room already shows a success-style echo; an unexpected throw must
    // leave the same kind of journal notice the fetch-failure path does.
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringContaining("Couldn't deliver"));
  });

  it('a fetched audio/* type is transcribed even when the frame declared a generic type', async () => {
    // The client uploaded with application/octet-stream but the store knows
    // it's audio — the declared type must not shadow the fetched one, or the
    // voice note gets saved as a file instead of transcribed.
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('aac'), contentType: 'audio/mp4' })),
    });
    await route(session, { type: 'file', blobRef: 'vn', contentType: 'application/octet-stream', name: 'voice-note.m4a' }, ctx);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.transcribe.mock.calls[0][1]).toBe('audio/mp4');
    expect(deps.buildSavedBlocks).not.toHaveBeenCalled();
  });
});

describe('createJournalMediaRouter — ordering', () => {
  it('serializes concurrent frames per conversation in arrival order', async () => {
    // First frame's fetch is slow, second's is instant — without per-convo
    // chaining the second would inject first and claude would see the
    // attachments out of journal order.
    let resolveFirst;
    const firstFetch = new Promise((r) => { resolveFirst = r; });
    const fetchMedia = vi.fn()
      .mockImplementationOnce(() => firstFetch)
      .mockImplementationOnce(async () => ({ buffer: Buffer.from('two'), contentType: 'application/pdf' }));
    const injected = [];
    const { route } = makeRouter({
      fetchMedia,
      buildSavedBlocks: vi.fn((sess, { name }) => [{ type: 'text', text: `saved:${name}` }]),
      injectBlocks: vi.fn((sess, blocks) => { injected.push(blocks[0].text); return true; }),
    });

    const p1 = route(session, { type: 'file', blobRef: 'b1', contentType: 'application/pdf', name: 'one.pdf' }, ctx);
    const p2 = route(session, { type: 'file', blobRef: 'b2', contentType: 'application/pdf', name: 'two.pdf' }, ctx);
    // Second frame must not even fetch until the first settles.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMedia).toHaveBeenCalledTimes(1);

    resolveFirst({ buffer: Buffer.from('one'), contentType: 'application/pdf' });
    await Promise.all([p1, p2]);
    expect(injected).toEqual(['saved:one.pdf', 'saved:two.pdf']);
  });
});

describe('createJournalMediaRouter — audio (voice note)', () => {
  it('an audio content-type is transcribed and injected as user text (mirrors the Matrix m.audio wording)', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('ogg'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => 'buy milk'),
    });
    await route(session, { type: 'file', blobRef: 'voice-1', contentType: 'audio/ogg', name: 'voice.ogg' }, ctx);

    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.transcribe.mock.calls[0][1]).toBe('audio/ogg');
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: buy milk');
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.buildSavedBlocks).not.toHaveBeenCalled();
  });

  it('detects audio from the fetched content-type even when the frame declared none', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'audio/mp4' })),
      transcribe: vi.fn(async () => 'hi'),
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: null, name: 'v.m4a' }, ctx);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: hi');
  });

  it('a failed transcription warns, notices, and drops — no injection', async () => {
    const warnings = [];
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => { throw new Error('whisper died'); }),
      log: { warn: (...a) => warnings.push(a.join(' ')), error: () => {} },
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'audio/ogg' }, ctx);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/transcribe/));
    expect(warnings.some(w => /transcription failed/.test(w))).toBe(true);
  });

  it('an empty transcript is dropped (no empty turn injected)', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => '   '),
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'audio/ogg' }, ctx);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/transcribe/));
  });
});

describe('createJournalMediaRouter — busy session queues instead of injecting', () => {
  const busySession = { claudeSessionId: 'convo-1', roomId: '!r:s', busy: true };

  it('a busy session QUEUES a saved file (mirrorToJournal:false), never injects it', async () => {
    const { route, deps } = makeRouter();
    await route(busySession, { type: 'file', blobRef: 'blob-1', contentType: 'application/pdf', name: 'report.pdf' }, ctx);

    expect(deps.buildSavedBlocks).toHaveBeenCalledTimes(1); // built eagerly
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.queueMedia).toHaveBeenCalledTimes(1);
    const [sess, entry] = deps.queueMedia.mock.calls[0];
    expect(sess).toBe(busySession);
    expect(entry).toMatchObject({
      blocks: [{ type: 'text', text: 'File saved to /w/report.pdf' }],
      mirrorToJournal: false,
      preview: 'report.pdf',
    });
  });

  it('a busy session QUEUES a voice-note transcript (mirrorToJournal:true), never injects it', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('ogg'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => 'buy milk'),
    });
    await route(busySession, { type: 'file', blobRef: 'voice-1', contentType: 'audio/ogg', name: 'voice.ogg' }, ctx);

    expect(deps.transcribe).toHaveBeenCalledTimes(1); // transcribed eagerly
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.queueMedia).toHaveBeenCalledTimes(1);
    const [, entry] = deps.queueMedia.mock.calls[0];
    expect(entry).toMatchObject({
      blocks: [{ type: 'text', text: '[Voice note transcription]: buy milk' }],
      mirrorToJournal: true,
      preview: '🎤 buy milk',
    });
  });

  it('falls back to immediate injection when busy but no queueMedia seam is wired', async () => {
    const { route, deps } = makeRouter({ queueMedia: undefined });
    await route(busySession, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
  });

  it('an idle session still injects immediately (queueMedia untouched)', async () => {
    const { route, deps } = makeRouter();
    await route(session, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.queueMedia).not.toHaveBeenCalled();
  });
});
