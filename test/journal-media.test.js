import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createJournalMediaRouter, chooseNarration, EMPTY_VOICE_NOTICE, JOURNAL_FAILED_NOTICE, JOURNAL_BUSY_NOTICE,
} from '../lib/journal-media.js';

const silentLog = { warn: () => {}, error: () => {} };

// Fully-injected orchestrator: every I/O boundary (fetchMedia, transcribe, the
// save/build + inject sinks) is a mock, so the fetch -> transcribe/save ->
// inject flow is exercised without a journal server, whisper, or a real claude
// session. The returned routeMedia is async and must never throw/reject.
// The harness box has local whisper installed (hasLocalWhisper true), which is
// what the transcribe-here tests below are about; the journal-first tests
// override it to false.
function makeRouter(overrides = {}) {
  const deps = {
    fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('bytes'), contentType: 'application/pdf' })),
    transcribe: vi.fn(async () => 'hello world'),
    hasLocalWhisper: vi.fn(() => true),
    buildSavedBlocks: vi.fn(() => [{ type: 'text', text: 'File saved to /w/report.pdf' }]),
    injectText: vi.fn(() => true),
    injectBlocks: vi.fn(() => true),
    queueMedia: vi.fn(async () => {}),
    isCanonicalSession: vi.fn(() => true),
    echoToRoom: vi.fn(),
    publishNotice: vi.fn(),
    escapeHtml: (s) => String(s),
    log: silentLog,
    ...overrides,
  };
  return { route: createJournalMediaRouter(deps), deps };
}

const session = { claudeSessionId: 'convo-1', roomId: '!r:s' };
const ctx = { username: 'alice' };

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

  // The generic notice sent the operator hunting through service logs for the
  // real cause (`spawn ffmpeg ENOENT`), so an uninstalled box now says so and
  // names the fix.
  it('an uninstalled transcription stack notices the install gap, not a generic failure', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => {
        throw Object.assign(new Error('ffmpeg is not installed on this box (not found on PATH)'),
          { code: 'TRANSCRIBE_UNAVAILABLE', dependency: 'ffmpeg' });
      }),
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'audio/ogg' }, ctx);
    expect(deps.injectText).not.toHaveBeenCalled();
    const notice = deps.publishNotice.mock.calls[0][1];
    expect(notice).toMatch(/isn't set up on this box/);
    expect(notice).toMatch(/ffmpeg/);
    expect(notice).toMatch(/install-whisper\.sh/);
  });

  it('an empty transcript is dropped (no empty turn injected) and asks for a re-recording', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => '   '),
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'audio/ogg' }, ctx);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', EMPTY_VOICE_NOTICE);
  });
});

describe('createJournalMediaRouter — voice note sent with the typed draft (caption)', () => {
  const audio = (extra = {}) => ({ type: 'file', blobRef: 'vn', contentType: 'audio/mp4', name: 'voice-note.m4a', ...extra });

  it('one injection: the typed text, then the transcript — and only the transcript is mirrored', async () => {
    const mirrorText = vi.fn();
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('m4a'), contentType: 'audio/mp4' })),
      transcribe: vi.fn(async () => 'what do you think of this'),
      mirrorText,
    });
    await route(session, audio({ caption: 'https://example.com/post' }), ctx);

    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1]).toEqual([
      { type: 'text', text: 'https://example.com/post' },
      { type: 'text', text: '[Voice note transcription]: what do you think of this' },
    ]);
    expect(mirrorText).toHaveBeenCalledWith(session, '[Voice note transcription]: what do you think of this');
    expect(deps.echoToRoom).toHaveBeenCalledTimes(2); // "sent a voice note" + the words
  });

  it('uses the journal transcript when it has one', async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => ({ status: 'done', transcript: ' from the cloud ' })),
      mirrorText: vi.fn(),
    });
    await route(session, audio({ caption: 'typed' }), ctx);
    expect(deps.fetchMedia).not.toHaveBeenCalled();
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text))
      .toEqual(['typed', '[Voice note transcription]: from the cloud']);
  });

  it('a failed transcription still delivers the typed text, with the notice', async () => {
    const mirrorText = vi.fn();
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('m4a'), contentType: 'audio/mp4' })),
      transcribe: vi.fn(async () => { throw new Error('whisper died'); }),
      mirrorText,
    });
    await route(session, audio({ caption: 'typed' }), ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', '🎤 Could not transcribe that voice note.');
    expect(deps.injectBlocks.mock.calls[0][1]).toEqual([{ type: 'text', text: 'typed' }]);
    expect(mirrorText).not.toHaveBeenCalled();
  });

  it('a failed fetch still delivers the typed text', async () => {
    const { route, deps } = makeRouter({ fetchMedia: vi.fn(async () => null), mirrorText: vi.fn() });
    await route(session, audio({ caption: 'typed' }), ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/voice note/));
    expect(deps.injectBlocks.mock.calls[0][1]).toEqual([{ type: 'text', text: 'typed' }]);
  });

  it('mid-turn it queues as one entry and mirrors the transcript', async () => {
    const mirrorText = vi.fn();
    const busy = { ...session, busy: true };
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('m4a'), contentType: 'audio/mp4' })),
      mirrorText,
    });
    await route(busy, audio({ caption: 'typed' }), ctx);
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.queueMedia).toHaveBeenCalledTimes(1);
    const entry = deps.queueMedia.mock.calls[0][1];
    expect(entry.mirrorToJournal).toBe(false);
    expect(entry.blocks.map((b) => b.text)).toEqual(['typed', '[Voice note transcription]: hello world']);
    expect(entry.preview).toBe('🎤 hello world');
    expect(mirrorText).toHaveBeenCalledWith(busy, '[Voice note transcription]: hello world');
  });

  it('an unavailable session notices and mirrors nothing', async () => {
    const mirrorText = vi.fn();
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('m4a'), contentType: 'audio/mp4' })),
      injectBlocks: vi.fn(() => false),
      mirrorText,
    });
    await route(session, audio({ caption: 'typed' }), ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/isn't available/));
    expect(mirrorText).not.toHaveBeenCalled();
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

describe('createJournalMediaRouter — session torn down during async prep (canonicality guard)', () => {
  const busySession = { claudeSessionId: 'convo-1', roomId: '!r:s', busy: true };

  it('a session already gone at fetch time drops a saved file EARLY — before the disk-writing build (no orphan file)', async () => {
    const { route, deps } = makeRouter({ isCanonicalSession: () => false });
    await route(busySession, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'report.pdf' }, ctx);

    expect(deps.buildSavedBlocks).not.toHaveBeenCalled(); // early guard skips the side-effecting prep
    expect(deps.queueMedia).not.toHaveBeenCalled();
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledTimes(1);
    const [convoId, body] = deps.publishNotice.mock.calls[0];
    expect(convoId).toBe('convo-1');
    expect(body).toMatch(/report\.pdf/);
    expect(body).toMatch(/session ended/);
  });

  it('a session already gone at fetch time drops a voice note EARLY — before transcription (no wasted CPU)', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('ogg'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => 'buy milk'),
      isCanonicalSession: () => false,
    });
    await route(busySession, { type: 'file', blobRef: 'v', contentType: 'audio/ogg', name: 'voice.ogg' }, ctx);

    expect(deps.transcribe).not.toHaveBeenCalled(); // early guard skips transcription
    expect(deps.queueMedia).not.toHaveBeenCalled();
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/voice note/);
  });

  it('reads canonicality at DELIVERY too: a session live at fetch but torn down DURING the build is still dropped (never queued)', async () => {
    let live = true;
    const { route, deps } = makeRouter({
      // Passes the early guard (live at fetch time), then goes non-canonical
      // while the async build runs — the delivery-time guard must still catch it.
      buildSavedBlocks: vi.fn(async () => { live = false; return [{ type: 'text', text: 'saved' }]; }),
      isCanonicalSession: () => live,
    });
    await route(busySession, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);

    expect(deps.buildSavedBlocks).toHaveBeenCalledTimes(1); // early guard passed; build ran
    expect(deps.queueMedia).not.toHaveBeenCalled();         // delivery guard caught the mid-build teardown
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledTimes(1);
  });

  it('a still-canonical busy session queues as before — the guard does not regress the happy path', async () => {
    const { route, deps } = makeRouter({ isCanonicalSession: () => true });
    await route(busySession, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);

    expect(deps.queueMedia).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice).not.toHaveBeenCalled();
  });

  it('publishes the drop notice to the STABLE journal convo id, not the native session id (survives an agent switch)', async () => {
    // After a switch the captured session keeps journalConvoId (the server-known
    // conversation) but its claudeSessionId is the new native id. The notice
    // must target journalConvoId, or the journal server rejects the publish and
    // the user sees neither the media nor the promised failure notice.
    const switchedSession = { claudeSessionId: 'native-new', journalConvoId: 'stable-convo', roomId: '!r:s', busy: true };
    const { route, deps } = makeRouter({ isCanonicalSession: () => false });
    await route(switchedSession, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'report.pdf' }, ctx);

    expect(deps.queueMedia).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice.mock.calls[0][0]).toBe('stable-convo');
  });

  it('fails loud at construction when isCanonicalSession is not wired', () => {
    expect(() => createJournalMediaRouter({
      fetchMedia: vi.fn(), transcribe: vi.fn(), buildSavedBlocks: vi.fn(),
      injectText: vi.fn(), injectBlocks: vi.fn(), echoToRoom: vi.fn(), publishNotice: vi.fn(),
      // isCanonicalSession deliberately omitted
    })).toThrow(/isCanonicalSession/);
  });
});

describe('createJournalMediaRouter — remaining teardown windows past the delivery-time canonicality guard', () => {
  const busySession = { claudeSessionId: 'convo-1', roomId: '!r:s', busy: true };

  // WINDOW: post-transcribe echo. The transcript is echoed to the room BEFORE
  // liveness is rechecked. A session torn down DURING transcription must not
  // have its transcript echoed into a dead/detached room — the recheck belongs
  // ahead of the echo, not only ahead of the enqueue/inject.
  it('a voice note torn down DURING transcription is NOT echoed to the room and drops with a notice', async () => {
    // Live at fetch (early guard passes), non-canonical by the time transcribe
    // resolves — so exactly one isCanonicalSession call succeeds (the early
    // one) and the delivery-side recheck fails.
    const isCanonicalSession = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('ogg'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => 'buy milk'),
      isCanonicalSession,
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'audio/ogg', name: 'voice.ogg' }, ctx);

    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    // Only the top "sent a voice note" echo fires — NOT the "🎤 …transcript" echo.
    expect(deps.echoToRoom).toHaveBeenCalledTimes(1);
    expect(deps.echoToRoom.mock.calls.every(([, plain]) => !String(plain).includes('buy milk'))).toBe(true);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.queueMedia).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/voice note/);
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/session ended/);
  });

  // WINDOW: orphan saved files. buildSavedBlocks writes the file to disk as a
  // side effect. When the delivery-time guard drops the media AFTER the build,
  // the saved file must be cleaned up, or it lingers in the session uploads dir
  // forever. buildSavedBlocks may return { blocks, cleanup }; the router calls
  // cleanup on every post-build drop path.
  it('cleans up the saved file when a session is torn down DURING the build (no orphan on disk)', async () => {
    const cleanup = vi.fn();
    const isCanonicalSession = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const { route, deps } = makeRouter({
      buildSavedBlocks: vi.fn(async () => ({ blocks: [{ type: 'text', text: 'File saved to /w/x.pdf' }], cleanup })),
      isCanonicalSession,
    });
    await route(busySession, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);

    expect(deps.buildSavedBlocks).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);         // orphan removed
    expect(deps.queueMedia).not.toHaveBeenCalled();
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/session ended/);
  });

  it('cleans up the saved file when the session is unavailable at inject (injectBlocks false)', async () => {
    const cleanup = vi.fn();
    const { route, deps } = makeRouter({
      buildSavedBlocks: vi.fn(async () => ({ blocks: [{ type: 'text', text: 'File saved to /w/x.pdf' }], cleanup })),
      injectBlocks: vi.fn(() => false),
    });
    await route(session, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/isn't available/));
  });

  it('does NOT clean up the saved file on the happy path — the file is referenced by the delivered blocks', async () => {
    const cleanup = vi.fn();
    const blocks = [{ type: 'text', text: 'File saved to /w/x.pdf' }];
    const { route, deps } = makeRouter({
      buildSavedBlocks: vi.fn(async () => ({ blocks, cleanup })),
    });
    await route(session, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);

    expect(deps.injectBlocks).toHaveBeenCalledWith(session, blocks);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('hands cleanup to the QUEUE (not called now) when a still-canonical busy session queues the saved file', async () => {
    const cleanup = vi.fn();
    const { route, deps } = makeRouter({
      buildSavedBlocks: vi.fn(async () => ({ blocks: [{ type: 'text', text: 'File saved to /w/x.pdf' }], cleanup })),
    });
    await route(busySession, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);

    expect(deps.queueMedia).toHaveBeenCalledTimes(1);
    // The queue owns the cleanup — it fires only if the entry is later
    // cancelled/evicted/dropped, so the file survives to be read on flush.
    expect(deps.queueMedia.mock.calls[0][1].cleanup).toBe(cleanup);
    expect(cleanup).not.toHaveBeenCalled();
  });

  // WINDOW: handoff drain. The router exposes in-flight media tracking keyed by
  // the STABLE journal conversation id, so the /switch gate can refuse while an
  // attachment for this conversation is still mid-prep (see agent-handoff test).
  it('exposes in-flight media tracking keyed by the stable conversation id', async () => {
    let resolveFetch;
    const fetchMedia = vi.fn(() => new Promise((r) => { resolveFetch = r; }));
    const { route } = makeRouter({ fetchMedia });
    const sess = { claudeSessionId: 'native-new', journalConvoId: 'stable-convo', roomId: '!r:s' };

    expect(route.hasInflightMedia(sess)).toBe(false);
    const p = route(sess, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    // The counter increments SYNCHRONOUSLY at enqueue time — the switch gate
    // must see the in-flight frame before the chain even reaches fetchMedia.
    expect(route.hasInflightMedia(sess)).toBe(true);            // prep in flight
    // Same stable convo, different native id (post-switch shape) still tracked.
    expect(route.hasInflightMedia({ journalConvoId: 'stable-convo' })).toBe(true);

    // Let the per-convo chain reach fetchMedia (runs on a microtask) so its
    // resolver is captured, then complete the fetch.
    await new Promise((r) => setTimeout(r, 5));
    resolveFetch({ buffer: Buffer.from('x'), contentType: 'application/pdf' });
    await p;
    expect(route.hasInflightMedia(sess)).toBe(false);           // drained
  });

  it('the in-flight gate is age-bounded so a stalled prep cannot wedge /switch forever', async () => {
    // A hung fetch (no application timeout) would otherwise pin the counter and
    // block every handoff. Past inflightGateMs the entry stops gating.
    let t = 1_000;
    const fetchMedia = vi.fn(() => new Promise(() => {})); // never resolves
    const deps = {
      fetchMedia,
      transcribe: vi.fn(),
      buildSavedBlocks: vi.fn(),
      injectText: vi.fn(),
      injectBlocks: vi.fn(),
      queueMedia: vi.fn(async () => {}),
      isCanonicalSession: vi.fn(() => true),
      echoToRoom: vi.fn(),
      publishNotice: vi.fn(),
      escapeHtml: (s) => String(s),
      log: silentLog,
      inflightGateMs: 5_000,
      now: () => t,
    };
    const route = createJournalMediaRouter(deps);
    const sess = { claudeSessionId: 'convo-1', journalConvoId: 'stable', roomId: '!r:s' };

    route(sess, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    expect(route.hasInflightMedia(sess)).toBe(true);   // fresh — gates the switch
    t += 4_999;
    expect(route.hasInflightMedia(sess)).toBe(true);   // still within the window
    t += 2;                                            // now past inflightGateMs
    expect(route.hasInflightMedia(sess)).toBe(false);  // stops gating — no wedge
  });

  it('a fresh attachment does NOT inherit an older frame\'s expiry (gate anchored to the newest frame)', async () => {
    let t = 0;
    const fetchMedia = vi.fn(() => new Promise(() => {})); // both frames hang
    const deps = {
      fetchMedia,
      transcribe: vi.fn(), buildSavedBlocks: vi.fn(), injectText: vi.fn(), injectBlocks: vi.fn(),
      queueMedia: vi.fn(async () => {}), isCanonicalSession: vi.fn(() => true),
      echoToRoom: vi.fn(), publishNotice: vi.fn(), escapeHtml: (s) => String(s), log: silentLog,
      inflightGateMs: 5_000, now: () => t,
    };
    const route = createJournalMediaRouter(deps);
    const sess = { claudeSessionId: 'convo-1', journalConvoId: 'stable', roomId: '!r:s' };

    route(sess, { type: 'file', blobRef: 'a', contentType: 'application/pdf', name: 'a.pdf' }, ctx); // frame 1 @ t=0
    t = 4_999;
    route(sess, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'b.pdf' }, ctx); // frame 2 @ t=4999
    t = 5_001; // past frame 1's window, but frame 2 is only 2ms old
    expect(route.hasInflightMedia(sess)).toBe(true);   // fresh frame keeps the gate — not dropped
    t = 10_000; // past frame 2's window too, nothing newer arrived
    expect(route.hasInflightMedia(sess)).toBe(false);  // now genuinely stalled — stops gating
  });
});

describe('createJournalMediaRouter — video (frame extraction)', () => {
  const videoFetch = () => vi.fn(async () => ({ buffer: Buffer.from('mov'), contentType: 'video/quicktime' }));
  const videoBlocks = [{ type: 'text', text: '🎬 Video attached: clip.mov (13s screen recording). 4 key frames…' }];

  it('a video content-type routes through buildVideoBlocks and injects its blocks', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(),
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, { type: 'file', blobRef: 'vid-1', contentType: 'video/quicktime', name: 'clip.mov', caption: 'find the bug' }, ctx);

    expect(deps.buildVideoBlocks).toHaveBeenCalledTimes(1);
    const [sess, args] = deps.buildVideoBlocks.mock.calls[0];
    expect(sess).toBe(session);
    expect(args).toMatchObject({ mime: 'video/quicktime', name: 'clip.mov', caption: 'find the bug' });
    expect(deps.injectBlocks).toHaveBeenCalledWith(session, videoBlocks);
    expect(deps.buildSavedBlocks).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it('room echo says "a video", not "a file"', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(),
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'video/quicktime', name: 'clip.mov' }, ctx);
    expect(deps.echoToRoom.mock.calls[0][1]).toMatch(/sent a video/);
  });

  it('detects video from the fetched content-type when the frame declared octet-stream', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(),
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'application/octet-stream', name: 'clip.mov' }, ctx);
    expect(deps.buildVideoBlocks).toHaveBeenCalledTimes(1);
    expect(deps.buildVideoBlocks.mock.calls[0][1].mime).toBe('video/quicktime');
  });

  it('falls back to the plain file path when extraction throws (raw video still delivered)', async () => {
    const warnings = [];
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(),
      buildVideoBlocks: vi.fn(async () => { throw new Error('ffmpeg not found'); }),
      log: { warn: (...a) => warnings.push(a.join(' ')), error: () => {} },
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'video/quicktime', name: 'clip.mov' }, ctx);

    expect(deps.buildSavedBlocks).toHaveBeenCalledTimes(1); // raw-file fallback
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(warnings.some((w) => /frame extraction failed/.test(w))).toBe(true);
    // The fallback is otherwise invisible: the user sees a normal "sent a
    // video" echo and claude gets an unreadable binary. Say so.
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/raw file/));
  });

  it('falls back to the plain file path when buildVideoBlocks returns null/empty', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(),
      buildVideoBlocks: vi.fn(async () => null),
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'video/quicktime', name: 'clip.mov' }, ctx);
    expect(deps.buildSavedBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    // Extraction ran and produced nothing — same user-visible outcome as a
    // throw, same notice.
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/raw file/));
  });

  it('routes video as a plain file when no buildVideoBlocks seam is wired (backwards compatible)', async () => {
    const { route, deps } = makeRouter({ fetchMedia: videoFetch() });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'video/quicktime', name: 'clip.mov' }, ctx);
    expect(deps.buildSavedBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    // No extraction was ever attempted here, so there's nothing to apologise
    // for — the fallback notice belongs to a FAILED extraction only.
    expect(deps.publishNotice).not.toHaveBeenCalled();
  });

  it('a busy session QUEUES the video frames entry (mirrorToJournal:false, 🎬 preview)', async () => {
    const busySession = { claudeSessionId: 'convo-1', roomId: '!r:s', busy: true };
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(),
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(busySession, { type: 'file', blobRef: 'v', contentType: 'video/quicktime', name: 'clip.mov' }, ctx);

    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.queueMedia).toHaveBeenCalledTimes(1);
    const [, entry] = deps.queueMedia.mock.calls[0];
    expect(entry).toMatchObject({
      blocks: videoBlocks,
      mirrorToJournal: false,
      preview: '🎬 clip.mov',
    });
  });
});

describe('createJournalMediaRouter — transcript from the journal (transcribed at upload)', () => {
  const voice = { type: 'file', blobRef: 'vn-1', contentType: 'audio/mp4', name: 'note.m4a' };

  it("uses the journal's words: no audio fetched, no local whisper, same wording as a local transcript", async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'done', transcript: '  deploy the journal  ' }));
    const { route, deps } = makeRouter({ fetchTranscript });
    await route(session, voice, ctx);
    expect(fetchTranscript).toHaveBeenCalledWith('vn-1');
    expect(deps.fetchMedia).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: deploy the journal');
    expect(deps.echoToRoom).toHaveBeenLastCalledWith(session, '🎤 alice (Matron): deploy the journal', expect.any(String));
  });

  it('a busy session queues the journal transcript exactly like a local one', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'done', transcript: 'later please' }));
    const { route, deps } = makeRouter({ fetchTranscript });
    await route({ ...session, busy: true }, voice, ctx);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.queueMedia).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      mirrorToJournal: true, fullText: '[Voice note transcription]: later please', preview: '🎤 later please',
    }));
  });

  // A box with local whisper: anything short of the journal's words falls back
  // to it — but failed/none ask the journal to try again first, and pending
  // waits once more, before this box spends a whisper run.
  it.each([
    ['failed, and failed again on the retry', { status: 'failed' }, { status: 'pending' }, [{ status: 'failed' }], 1],
    ['none (journal has no cloud transcriber), and none on the retry', { status: 'none' }, { status: 'none' }, [], 1],
    ['still pending after waiting once more', { status: 'pending' }, null, [{ status: 'pending' }], 0],
    ['done but empty', { status: 'done', transcript: '   ' }, null, [], 0],
    ['null (older journal, network error)', null, null, [], 0],
  ])('falls back to fetch + local whisper when the journal answer is %s', async (_label, first, posted, later, posts) => {
    const answers = [first, ...later];
    const fetchTranscript = vi.fn(async () => (answers.length > 1 ? answers.shift() : answers[0]));
    const requestTranscript = vi.fn(async () => posted);
    const { route, deps } = makeRouter({
      fetchTranscript,
      requestTranscript,
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
    });
    await route(session, voice, ctx);
    expect(fetchTranscript.mock.calls[0]).toEqual(['vn-1']);
    expect(fetchTranscript).toHaveBeenCalledTimes(1 + later.length);
    for (const call of fetchTranscript.mock.calls.slice(1)) expect(call).toEqual(['vn-1', { waitS: 30 }]);
    expect(requestTranscript).toHaveBeenCalledTimes(posts);
    expect(deps.fetchMedia).toHaveBeenCalledWith('vn-1');
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: hello world');
  });

  // A silent 0.07 s note: the journal's transcriber marked it 'failed', the
  // bridge fell back to a whisper this box doesn't have, and the user was told
  // to install whisper. The recording was the problem, so say that — once the
  // journal has failed it twice.
  it("journal 'failed' twice on a box without whisper asks for a re-recording, not an install", async () => {
    const { route, deps } = makeRouter({
      hasLocalWhisper: () => false,
      fetchTranscript: vi.fn(async () => ({ status: 'failed' })),
      requestTranscript: vi.fn(async () => ({ status: 'pending' })),
    });
    await route(session, voice, ctx);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.fetchMedia).not.toHaveBeenCalled();
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', JOURNAL_FAILED_NOTICE);
  });

  it.each([
    ['none (journal has no cloud transcriber)', { status: 'none' }],
    ['null (older journal, network error)', null],
  ])('journal answer %s on a box without whisper still names the install gap', async (_label, answer) => {
    const { route, deps } = makeRouter({
      hasLocalWhisper: () => false,
      fetchTranscript: vi.fn(async () => answer),
      requestTranscript: vi.fn(async () => answer),
    });
    await route(session, voice, ctx);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/isn't set up on this box \(whisper\.cpp missing\)/);
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/install-whisper\.sh/);
  });

  // A box whose whisper is installed but whose ffmpeg is not: the engine names
  // the missing piece, and that is still the notice.
  it('a local whisper that turns out unusable names the missing dependency', async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => ({ status: 'none' })),
      requestTranscript: vi.fn(async () => ({ status: 'none' })),
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
      transcribe: vi.fn(async () => {
        throw Object.assign(new Error('ffmpeg is not installed'), { code: 'TRANSCRIBE_UNAVAILABLE', dependency: 'ffmpeg' });
      }),
    });
    await route(session, voice, ctx);
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/isn't set up on this box \(ffmpeg missing\)/);
  });

  it('whisper hearing no words (TRANSCRIBE_EMPTY) asks for a re-recording', async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => ({ status: 'failed' })),
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
      transcribe: vi.fn(async () => {
        throw Object.assign(new Error('empty transcription result'), { code: 'TRANSCRIBE_EMPTY' });
      }),
    });
    await route(session, voice, ctx);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', EMPTY_VOICE_NOTICE);
  });

  it("journal 'failed' then a local whisper error keeps the generic notice", async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => ({ status: 'failed' })),
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
      transcribe: vi.fn(async () => { throw new Error('whisper died'); }),
    });
    await route(session, voice, ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', '🎤 Could not transcribe that voice note.');
  });

  it('a throwing fetchTranscript falls back too (the router never throws)', async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => { throw new Error('boom'); }),
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
    });
    await route(session, voice, ctx);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.injectText).toHaveBeenCalledTimes(1);
  });

  it('is not asked for files, images, or audio the frame did not declare as audio', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'done', transcript: 'x' }));
    const { route } = makeRouter({ fetchTranscript });
    await route(session, { type: 'file', blobRef: 'f', contentType: 'application/pdf', name: 'a.pdf' }, ctx);
    await route(session, { type: 'image', blobRef: 'i', contentType: 'image/png', name: 'a.png' }, ctx);
    await route(session, { type: 'file', blobRef: 'o', contentType: 'application/octet-stream', name: 'a.bin' }, ctx);
    expect(fetchTranscript).not.toHaveBeenCalled();
  });
});

// The journal is the transcriber: a bridge asks it, asks it again when it has
// nothing, and runs whisper itself only when whisper is actually installed
// here (hasLocalWhisper). The notice says which of those ran out.
describe('createJournalMediaRouter — journal first, local whisper only when installed', () => {
  const voice = { type: 'file', blobRef: 'vn-2', contentType: 'audio/mp4', name: 'note.m4a' };
  const sequence = (...answers) => vi.fn(async () => (answers.length > 1 ? answers.shift() : answers[0]));

  it('voice: journal failed → POST retry → done delivers words, local transcribe never called', async () => {
    const fetchTranscript = sequence({ status: 'failed' }, { status: 'done', transcript: ' second time lucky ' });
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript });
    await route(session, voice, ctx);
    expect(requestTranscript).toHaveBeenCalledTimes(1);
    expect(requestTranscript).toHaveBeenCalledWith('vn-2');
    expect(fetchTranscript.mock.calls).toEqual([['vn-2'], ['vn-2', { waitS: 30 }]]);
    expect(deps.fetchMedia).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: second time lucky');
    expect(deps.publishNotice).not.toHaveBeenCalled();
  });

  it('voice: a retry that answers done at once delivers without another wait', async () => {
    const fetchTranscript = sequence({ status: 'failed' });
    const requestTranscript = vi.fn(async () => ({ status: 'done', transcript: 'already there' }));
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript, hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: already there');
  });

  it('voice: journal failed twice, no local whisper → JOURNAL_FAILED_NOTICE', async () => {
    const fetchTranscript = sequence({ status: 'failed' }, { status: 'failed' });
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript, hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(requestTranscript).toHaveBeenCalledTimes(1);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.fetchMedia).not.toHaveBeenCalled();
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', JOURNAL_FAILED_NOTICE);
    expect(JOURNAL_FAILED_NOTICE).toMatch(/journal couldn't transcribe/i);
    expect(JOURNAL_FAILED_NOTICE.startsWith("🎤 The journal couldn't transcribe that voice note")).toBe(true);
  });

  it('voice: journal failed, retry none, local whisper available → local transcribe called once', async () => {
    const fetchTranscript = sequence({ status: 'failed' }, { status: 'none' });
    const requestTranscript = vi.fn(async () => ({ status: 'none' }));
    const { route, deps } = makeRouter({
      fetchTranscript,
      requestTranscript,
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
      transcribe: vi.fn(async () => 'heard it here'),
    });
    await route(session, voice, ctx);
    expect(requestTranscript).toHaveBeenCalledTimes(1);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: heard it here');
  });

  // A journal at its caps is the journal being busy, not this box missing
  // whisper: the install hint would be advice the operator can't act on.
  it('voice: a retry the journal could not queue (none, busy) is not waited on, and says the journal was busy', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'none' }));
    const requestTranscript = vi.fn(async () => ({ status: 'none', reason: 'busy' }));
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript, hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', JOURNAL_BUSY_NOTICE);
  });

  it('voice: a busy retry on a box with whisper falls back to it', async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => ({ status: 'none' })),
      requestTranscript: vi.fn(async () => ({ status: 'none', reason: 'busy' })),
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
    });
    await route(session, voice, ctx);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: hello world');
  });

  it('voice: a plain none on the retry (no transcriber on the journal), no local whisper → install hint', async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => ({ status: 'none' })),
      requestTranscript: vi.fn(async () => ({ status: 'none' })),
      hasLocalWhisper: () => false,
    });
    await route(session, voice, ctx);
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/install-whisper\.sh/);
  });

  // On a box with whisper the journal's retry gets one wait, not two: a
  // second minute of waiting buys nothing whisper here can't do itself.
  it('voice: journal failed, retry still pending after one wait, local whisper installed → local whisper', async () => {
    const fetchTranscript = sequence({ status: 'failed' }, { status: 'pending' });
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({
      fetchTranscript,
      requestTranscript,
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
    });
    await route(session, voice, ctx);
    expect(fetchTranscript.mock.calls).toEqual([['vn-2'], ['vn-2', { waitS: 30 }]]);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
  });

  // Review focus: an older journal has the GET but answers the retry POST 404
  // (requestTranscript null). The journal never got a second go, so on a box
  // without whisper the actionable answer is the install hint — never the
  // "journal couldn't transcribe" ask to re-record.
  it.each([
    ['fetchTranscript null (older journal)', null, null],
    ['GET failed, POST 404 (older journal)', { status: 'failed' }, null],
    ['GET none, POST 404 (older journal)', { status: 'none' }, null],
  ])('voice: %s, no local whisper → install hint', async (_label, got, posted) => {
    const fetchTranscript = vi.fn(async () => got);
    const requestTranscript = vi.fn(async () => posted);
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript, hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledTimes(1);
    const notice = deps.publishNotice.mock.calls[0][1];
    expect(notice).not.toBe(JOURNAL_FAILED_NOTICE);
    expect(notice).toMatch(/isn't set up on this box/);
    expect(notice).toMatch(/install-whisper\.sh/);
    // Asked again only when the journal answered at all.
    expect(requestTranscript).toHaveBeenCalledTimes(got ? 1 : 0);
  });

  it("voice: journal 'failed' with no retry wired and no local whisper → install hint", async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => ({ status: 'failed' })),
      hasLocalWhisper: () => false,
    });
    await route(session, voice, ctx);
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/install-whisper\.sh/);
  });

  it('voice: journal none (busy) → retry → pending then done within the second wait', async () => {
    const fetchTranscript = sequence(
      { status: 'none' },
      { status: 'pending' },
      { status: 'done', transcript: 'worth the wait' },
    );
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript, hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(requestTranscript).toHaveBeenCalledTimes(1);
    expect(fetchTranscript.mock.calls).toEqual([['vn-2'], ['vn-2', { waitS: 30 }], ['vn-2', { waitS: 30 }]]);
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: worth the wait');
    expect(deps.publishNotice).not.toHaveBeenCalled();
  });

  it('voice: a journal still pending after every wait, no local whisper → the journal-busy notice, no words', async () => {
    const fetchTranscript = sequence({ status: 'failed' }, { status: 'pending' });
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript, hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(fetchTranscript).toHaveBeenCalledTimes(3);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', JOURNAL_BUSY_NOTICE);
    expect(JOURNAL_BUSY_NOTICE).not.toMatch(/install-whisper/);
  });

  // A note the journal is already working on (pending at upload) gets the
  // same patience as one it was asked to retry: its whisper fallback can take
  // a couple of minutes. Total extra waits stay at most waits + 1 (no
  // whisper: 3 → 20 + 30 + 30 + 30 s), so the worst case is unchanged.
  it('voice: pending at upload, no local whisper → two more waits, then the journal-busy notice', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'pending' }));
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript, hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(fetchTranscript.mock.calls).toEqual([['vn-2'], ['vn-2', { waitS: 30 }], ['vn-2', { waitS: 30 }]]);
    expect(requestTranscript).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', JOURNAL_BUSY_NOTICE);
  });

  it('voice: pending at upload, done on the second extra wait, no local whisper → delivered', async () => {
    const fetchTranscript = sequence({ status: 'pending' }, { status: 'pending' }, { status: 'done', transcript: 'long note' });
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript: vi.fn(), hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(fetchTranscript).toHaveBeenCalledTimes(3);
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: long note');
  });

  it('voice: pending at upload, local whisper installed → one more wait, then local whisper', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({
      fetchTranscript,
      requestTranscript: vi.fn(),
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
    });
    await route(session, voice, ctx);
    expect(fetchTranscript.mock.calls).toEqual([['vn-2'], ['vn-2', { waitS: 30 }]]);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
  });

  it('voice: pending twice, then failed, no local whisper → POST and one wait (the shared budget), ~110 s worst case', async () => {
    const fetchTranscript = sequence({ status: 'pending' }, { status: 'pending' }, { status: 'failed' }, { status: 'pending' });
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript, hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(requestTranscript).toHaveBeenCalledTimes(1);
    // 1 default GET + 3 waits of 30 s in all.
    expect(fetchTranscript).toHaveBeenCalledTimes(4);
    expect(fetchTranscript.mock.calls.slice(1).every((c) => c[1] && c[1].waitS === 30)).toBe(true);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', JOURNAL_BUSY_NOTICE);
  });

  it('voice: pending once, then failed, no local whisper → POST and two waits', async () => {
    const fetchTranscript = sequence({ status: 'pending' }, { status: 'failed' }, { status: 'pending' }, { status: 'done', transcript: 'got there' });
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript, hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(fetchTranscript).toHaveBeenCalledTimes(4);
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: got there');
  });

  // A journal that already answered 'pending' and then drops a wait (it
  // restarted mid-deploy, a proxy 5xx on the hold) was working on the note:
  // that is busy, never "install whisper on this box".
  it('voice: pending at upload, then the wait GET returns null, no local whisper → JOURNAL_BUSY_NOTICE, not the install hint', async () => {
    const fetchTranscript = sequence({ status: 'pending' }, null);
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript: vi.fn(), hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(fetchTranscript).toHaveBeenCalledTimes(2);
    expect(deps.publishNotice).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', JOURNAL_BUSY_NOTICE);
  });

  it('voice: a queued retry, then the wait GET returns null, no local whisper → JOURNAL_BUSY_NOTICE', async () => {
    const fetchTranscript = sequence({ status: 'failed' }, null);
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({ fetchTranscript, requestTranscript, hasLocalWhisper: () => false });
    await route(session, voice, ctx);
    expect(requestTranscript).toHaveBeenCalledTimes(1);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', JOURNAL_BUSY_NOTICE);
  });

  it('voice: a dropped wait GET on a box with whisper still falls back to it', async () => {
    const fetchTranscript = sequence({ status: 'pending' }, null);
    const { route, deps } = makeRouter({
      fetchTranscript,
      requestTranscript: vi.fn(),
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
    });
    await route(session, voice, ctx);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
  });

  it('JOURNAL_BUSY_NOTICE says the journal may still be working, to wait a couple of minutes or send shorter notes', () => {
    expect(JOURNAL_BUSY_NOTICE).toMatch(/may still be working/i);
    expect(JOURNAL_BUSY_NOTICE).toMatch(/couple of minutes/i);
    expect(JOURNAL_BUSY_NOTICE).toMatch(/shorter/i);
    expect(JOURNAL_BUSY_NOTICE).not.toMatch(/install-whisper/);
  });

  it('voice: the journal heard no words and an installed whisper turns out unusable → the empty-note notice', async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => ({ status: 'done', transcript: '' })),
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
      transcribe: vi.fn(async () => {
        throw Object.assign(new Error('ffmpeg is not installed'), { code: 'TRANSCRIBE_UNAVAILABLE', dependency: 'ffmpeg' });
      }),
    });
    await route(session, voice, ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', EMPTY_VOICE_NOTICE);
  });

  it('voice: the journal done with no words, no local whisper → the empty-note notice', async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => ({ status: 'done', transcript: '  ' })),
      requestTranscript: vi.fn(async () => ({ status: 'done', transcript: '  ' })),
      hasLocalWhisper: () => false,
    });
    await route(session, voice, ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', EMPTY_VOICE_NOTICE);
  });

  it('voice: a throwing requestTranscript is a missing retry, never a throw', async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => ({ status: 'failed' })),
      requestTranscript: vi.fn(async () => { throw new Error('boom'); }),
      hasLocalWhisper: () => false,
    });
    await route(session, voice, ctx);
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/install-whisper\.sh/);
  });

  it('voice: unwired hasLocalWhisper means no local whisper (it is opt-in)', async () => {
    const deps = {
      isCanonicalSession: () => true,
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => 'never'),
      buildSavedBlocks: vi.fn(() => []),
      injectText: vi.fn(() => true),
      injectBlocks: vi.fn(() => true),
      echoToRoom: vi.fn(),
      publishNotice: vi.fn(),
      log: silentLog,
    };
    const route = createJournalMediaRouter(deps);
    await route(session, { type: 'file', blobRef: 'v', contentType: 'audio/ogg' }, ctx);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/install-whisper\.sh/);
  });

  it('voice: audio only the store calls audio, no local whisper → install hint, no transcribe', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mp4' })),
      hasLocalWhisper: () => false,
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: null, name: 'v.m4a' }, ctx);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.buildSavedBlocks).not.toHaveBeenCalled();
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/install-whisper\.sh/);
  });

  it('voice: a throwing hasLocalWhisper counts as no local whisper', async () => {
    const { route, deps } = makeRouter({
      fetchTranscript: vi.fn(async () => null),
      hasLocalWhisper: () => { throw new Error('fs gone'); },
    });
    await route(session, voice, ctx);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.publishNotice.mock.calls[0][1]).toMatch(/install-whisper\.sh/);
  });

  const videoFetch = () => vi.fn(async () => ({ buffer: Buffer.from('mov'), contentType: 'video/quicktime' }));
  const video = { type: 'file', blobRef: 'vid-2', contentType: 'video/quicktime', name: 'clip.mov' };
  const videoBlocks = [{ type: 'text', text: '🎬 Video attached: clip.mov' }];

  it('video: journal done with segments → buildVideoBlocks receives narration [{start:1.2,text:\'b\'}]', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'done', transcript: 'b', segments: [{ start_ms: 1200, text: 'b' }] }));
    const requestTranscript = vi.fn(async () => null);
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(), fetchTranscript, requestTranscript,
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(fetchTranscript).toHaveBeenCalledWith('vid-2');
    expect(requestTranscript).not.toHaveBeenCalled();
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toEqual([{ start: 1.2, text: 'b' }]);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.injectBlocks).toHaveBeenCalledWith(session, videoBlocks);
  });

  // A video is never retried: the journal's own chain already fell back once,
  // and a failed video is almost always a silent one, so a retry would only
  // hold the frames back.
  it('video: journal failed → no POST, narration null, frames delivered', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'failed' }));
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(), fetchTranscript, requestTranscript, hasLocalWhisper: () => false,
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(requestTranscript).not.toHaveBeenCalled();
    expect(fetchTranscript.mock.calls).toEqual([['vid-2']]);
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toBeNull();
    expect(deps.injectBlocks).toHaveBeenCalledWith(session, videoBlocks);
    expect(deps.publishNotice).not.toHaveBeenCalled();
  });

  it('video: journal failed, local whisper installed → no POST, narration null (the builder narrates locally)', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'failed' }));
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(), fetchTranscript, requestTranscript,
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(requestTranscript).not.toHaveBeenCalled();
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toBeNull();
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it('video: journal pending → one more GET wait → done with segments is the narration', async () => {
    const fetchTranscript = sequence({ status: 'pending' }, { status: 'done', transcript: 'a b', segments: [{ start_ms: 0, text: 'a' }, { start_ms: 65_500, text: 'b' }] });
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(), fetchTranscript, requestTranscript,
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(requestTranscript).not.toHaveBeenCalled();
    expect(fetchTranscript.mock.calls).toEqual([['vid-2'], ['vid-2', { waitS: 30 }]]);
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toEqual([{ start: 0, text: 'a' }, { start: 65.5, text: 'b' }]);
  });

  it('video: journal none and no local whisper → narration null, frames still delivered', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'none' }));
    const requestTranscript = vi.fn(async () => ({ status: 'pending' }));
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(), fetchTranscript, requestTranscript, hasLocalWhisper: () => false,
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(requestTranscript).not.toHaveBeenCalled();
    expect(fetchTranscript.mock.calls).toEqual([['vid-2']]);
    expect(deps.buildVideoBlocks).toHaveBeenCalledTimes(1);
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toBeNull();
    expect(deps.injectBlocks).toHaveBeenCalledWith(session, videoBlocks);
    expect(deps.publishNotice).not.toHaveBeenCalled();
  });

  it('video: pending at upload and still pending after the one extra wait → narration null, no POST', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'pending' }));
    const requestTranscript = vi.fn();
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(), fetchTranscript, requestTranscript,
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(fetchTranscript.mock.calls).toEqual([['vid-2'], ['vid-2', { waitS: 30 }]]);
    expect(requestTranscript).not.toHaveBeenCalled();
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toBeNull();
  });

  // Segments the bridge can't read are an unknown, not the journal saying it
  // heard nothing: null keeps local narration possible.
  it('video: done with only malformed segments → narration null', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'done', transcript: 'x', segments: [{ start_ms: 'soon', text: 'x' }, { start_ms: 5, text: '  ' }, null] }));
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(), fetchTranscript,
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toBeNull();
  });

  it('video: done with an empty segments list → narration [] (the journal heard nothing)', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'done', transcript: '', segments: [] }));
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(), fetchTranscript,
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toEqual([]);
  });

  it('video: done with some malformed segments keeps the good ones', async () => {
    const fetchTranscript = vi.fn(async () => ({ status: 'done', transcript: 'a', segments: [{ start_ms: 'x', text: 'bad' }, { start_ms: 2000, text: 'a' }] }));
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(), fetchTranscript,
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toEqual([{ start: 2, text: 'a' }]);
  });

  it('video: an older journal (null) skips the retry and passes narration null', async () => {
    const fetchTranscript = vi.fn(async () => null);
    const requestTranscript = vi.fn(async () => null);
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(), fetchTranscript, requestTranscript,
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
    expect(requestTranscript).not.toHaveBeenCalled();
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toBeNull();
  });

  it('video: a throwing fetchTranscript still delivers the frames', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: videoFetch(),
      fetchTranscript: vi.fn(async () => { throw new Error('boom'); }),
      buildVideoBlocks: vi.fn(async () => videoBlocks),
    });
    await route(session, video, ctx);
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toBeNull();
    expect(deps.injectBlocks).toHaveBeenCalledWith(session, videoBlocks);
  });

  it('video: unwired fetchTranscript passes narration null (the builder decides)', async () => {
    const { route, deps } = makeRouter({ fetchMedia: videoFetch(), buildVideoBlocks: vi.fn(async () => videoBlocks) });
    await route(session, video, ctx);
    expect(deps.buildVideoBlocks.mock.calls[0][1].narration).toBeNull();
  });
});

// Each delivery names the user's message that started the turn
// (lib/turn-cause.js): the JOURNAL convo id and frame seq the input router
// passes in ctx, never the session's own id.
describe('createJournalMediaRouter — turn causes', () => {
  const said = (convoId, seq) => expect.objectContaining({ kind: 'user_message', ref: `${convoId}:${seq}` });
  const audio = () => ({ fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('ogg'), contentType: 'audio/ogg' })), transcribe: vi.fn(async () => 'buy milk') });
  const voice = { type: 'file', blobRef: 'voice-1', contentType: 'audio/ogg', name: 'voice.ogg' };
  const file = { type: 'file', blobRef: 'blob-1', contentType: 'application/pdf', name: 'report.pdf' };

  it('a voice note passes one user_message cause, ref <journal convo>:<seq>', async () => {
    const { route, deps } = makeRouter(audio());
    await route(session, voice, { username: 'alice', seq: 7, convoId: 'jc-1' });
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: buy milk', { causes: [said('jc-1', 7)] });
  });

  it('a voice note with a caption, and a file, pass it on injectBlocks', async () => {
    const a = makeRouter(audio());
    await a.route(session, { ...voice, caption: 'and this' }, { username: 'alice', seq: 3, convoId: 'jc-1' });
    expect(a.deps.injectBlocks.mock.calls[0][2]).toEqual({ causes: [said('jc-1', 3)] });
    const f = makeRouter();
    await f.route(session, file, { username: 'alice', seq: 4, convoId: 'jc-1' });
    expect(f.deps.injectBlocks.mock.calls[0][2]).toEqual({ causes: [said('jc-1', 4)] });
  });

  it('a busy session queues the cause with the entry, for the flush to merge', async () => {
    const v = makeRouter(audio());
    await v.route({ ...session, busy: true }, voice, { username: 'alice', seq: 5, convoId: 'jc-1' });
    expect(v.deps.queueMedia.mock.calls[0][1].cause).toEqual([said('jc-1', 5)]);
    const f = makeRouter();
    await f.route({ ...session, busy: true }, file, { username: 'alice', seq: 6, convoId: 'jc-1' });
    expect(f.deps.queueMedia.mock.calls[0][1].cause).toEqual([said('jc-1', 6)]);
  });

  it('a coalesced batch passes one cause per frame, in index order', async () => {
    const { route, deps } = makeRouter({ fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('img'), contentType: 'image/png' })) });
    const img = (index, name) => ({ type: 'image', blobRef: name, contentType: 'image/png', name, batch: { id: 'b1', index, total: 2 } });
    await route(session, img(2, 'two.png'), { username: 'alice', seq: 12, convoId: 'jc-1' });
    await route(session, img(1, 'one.png'), { username: 'alice', seq: 11, convoId: 'jc-1' });
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][2]).toEqual({ causes: [said('jc-1', 11), said('jc-1', 12)] });
  });

  it('a frame without a seq (or a journal convo id) passes no cause at all', async () => {
    const v = makeRouter(audio());
    await v.route(session, voice, { username: 'alice', convoId: 'jc-1' });
    expect(v.deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: buy milk');
    const f = makeRouter();
    await f.route(session, file, { username: 'alice', seq: 4 });
    expect(f.deps.injectBlocks).toHaveBeenCalledWith(session, [{ type: 'text', text: 'File saved to /w/report.pdf' }]);
    const q = makeRouter();
    await q.route({ ...session, busy: true }, file, ctx);
    expect(q.deps.queueMedia.mock.calls[0][1]).not.toHaveProperty('cause');
  });
});

// The narration decision index.js's video builder makes once the frames are
// out: the journal's narration when the router passed one, else this box's
// whisper only when it is installed and the recording has audio.
describe('chooseNarration', () => {
  const segs = [{ start: 1, text: 'local' }];

  it("uses the journal's narration and never runs whisper here", async () => {
    const transcribeSegments = vi.fn(async () => segs);
    const out = await chooseNarration({ journalNarration: [{ start: 0, text: 'j' }], hasAudio: true, hasLocalWhisper: () => true, transcribeSegments });
    expect(out).toEqual([{ start: 0, text: 'j' }]);
    expect(transcribeSegments).not.toHaveBeenCalled();
  });

  it("an empty journal narration is the journal's answer too (it heard nothing)", async () => {
    const transcribeSegments = vi.fn(async () => segs);
    expect(await chooseNarration({ journalNarration: [], hasAudio: true, hasLocalWhisper: () => true, transcribeSegments })).toEqual([]);
    expect(transcribeSegments).not.toHaveBeenCalled();
  });

  it('no journal narration, audio, whisper installed → local segments', async () => {
    const transcribeSegments = vi.fn(async () => segs);
    expect(await chooseNarration({ journalNarration: null, hasAudio: true, hasLocalWhisper: () => true, transcribeSegments })).toBe(segs);
    expect(transcribeSegments).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no local whisper', { hasAudio: true, hasLocalWhisper: () => false }],
    ['no audio stream', { hasAudio: false, hasLocalWhisper: () => true }],
    ['a throwing hasLocalWhisper', { hasAudio: true, hasLocalWhisper: () => { throw new Error('fs'); } }],
  ])('no journal narration and %s → null, whisper never run', async (_label, opts) => {
    const transcribeSegments = vi.fn(async () => segs);
    expect(await chooseNarration({ journalNarration: null, transcribeSegments, ...opts })).toBeNull();
    expect(transcribeSegments).not.toHaveBeenCalled();
  });

  it('a local whisper failure loses the narration, warns, never throws', async () => {
    const warnings = [];
    const out = await chooseNarration({
      journalNarration: null, hasAudio: true, hasLocalWhisper: () => true,
      transcribeSegments: vi.fn(async () => { throw new Error('whisper died'); }),
      log: { warn: (m) => warnings.push(m) },
    });
    expect(out).toBeNull();
    expect(warnings.some((w) => /whisper died/.test(w))).toBe(true);
  });
});

// index.js wiring (source inspection, comments stripped, whitespace-tolerant):
// the chat media router is journal-first and the video builder leaves the
// narration decision to chooseNarration with the same availability check.
describe('index.js journal media router wiring (source inspection)', () => {
  let wiring;
  let indexSrc;
  beforeAll(() => {
    indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf-8').replace(/^\s*\/\/.*$/gm, '');
    const start = indexSrc.indexOf('const journalMediaRouter = createJournalMediaRouter(');
    const end = indexSrc.indexOf('buildSavedBlocks:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    wiring = indexSrc.slice(start, end);
  });

  it('defines hasLocalWhisper once, from localWhisperAvailable and the configured model', () => {
    expect(indexSrc).toMatch(/import\s*\{[^}]*\blocalWhisperAvailable\b[^}]*\}\s*from\s*'\.\/lib\/transcribe\.js'/);
    expect(indexSrc).toMatch(/const\s+hasLocalWhisper\s*=\s*\(\)\s*=>\s*localWhisperAvailable\(\s*\{\s*modelPath:\s*WHISPER_MODEL_PATH\s*\}\s*\)/);
    expect(indexSrc.match(/localWhisperAvailable\(/g)).toHaveLength(1);
  });

  it('passes hasLocalWhisper, requestTranscript, and a fetchTranscript that forwards its wait', () => {
    // The router's own options end where the video builder begins, so a
    // hasLocalWhisper inside the builder's chooseNarration call can't stand
    // in for a missing router option.
    const optionsEnd = wiring.indexOf('buildVideoBlocks:');
    expect(optionsEnd).toBeGreaterThan(-1);
    const routerOptions = wiring.slice(0, optionsEnd);
    expect(routerOptions).toMatch(/\bhasLocalWhisper\b\s*(,|:\s*hasLocalWhisper\b)/);
    expect(wiring).toMatch(/requestTranscript:\s*\((\w+)\)\s*=>\s*journalPublisher\.requestTranscript\(\s*\1\s*\)/);
    expect(wiring).toMatch(/fetchTranscript:\s*\((\w+),\s*(\w+)\)\s*=>\s*journalPublisher\.fetchTranscript\(\s*\1,\s*\2\s*\)/);
  });

  it('the video builder narrates through chooseNarration, with hasLocalWhisper; whisper runs only as its transcribeSegments', () => {
    const at = wiring.indexOf('chooseNarration(');
    expect(at).toBeGreaterThan(-1);
    const end = wiring.indexOf('});', at);
    expect(end).toBeGreaterThan(at);
    const call = wiring.slice(at, end);
    expect(call).toMatch(/\bjournalNarration\b/);
    expect(call).toMatch(/\bhasLocalWhisper\s*(,|\}|:\s*hasLocalWhisper\b)/);
    expect(call).toMatch(/\btranscribeSegments:\s*async\s*\(\)\s*=>\s*transcribeAudioSegments\(/);
    expect(wiring.match(/transcribeAudioSegments\(/g)).toHaveLength(1);
  });
});
