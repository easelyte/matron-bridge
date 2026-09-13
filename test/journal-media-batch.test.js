import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { createJournalMediaRouter } from '../lib/journal-media.js';
import { createJournalPublisher } from '../lib/journal-publisher.js';

const silentLog = { warn: () => {}, error: () => {} };

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// A fake journal blob store that serves the blobs it's given and STALLS on
// everything else: headers written, body never sent, socket held open. That's
// the real-world half-dead connection (cellular drop mid-download) the
// fetchMedia abort deadline exists to bound — no fake can reproduce it from
// the injected-mock side, so this test drives the router through the real
// publisher.fetchMedia.
function startStallingBlobServer(bodies) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent((req.url || '').replace(/^\/media\//, ''));
    const body = bodies[id];
    if (!body) {
      // Never res.end() — the client hangs in res.arrayBuffer() forever.
      res.writeHead(200, { 'content-type': 'image/png' });
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.length) });
    res.end(body);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(r);
        }),
      });
    });
    server.on('error', reject);
  });
}

// Same fully-injected harness as journal-media.test.js — see there for the
// rationale. These tests cover the multi-attachment batch path: frames
// sharing a batch_id (the composer's one-message-many-attachments marker)
// must reach claude as ONE injection, not a first image that starts a turn
// plus a busy-queued remainder.
function makeRouter(overrides = {}) {
  const deps = {
    fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('bytes'), contentType: 'image/png' })),
    transcribe: vi.fn(async () => 'hello world'),
    buildSavedBlocks: vi.fn((sess, { name }) => [{ type: 'text', text: `saved:${name}` }]),
    injectText: vi.fn(() => true),
    injectBlocks: vi.fn(() => true),
    queueMedia: vi.fn(async () => {}),
    echoToRoom: vi.fn(),
    publishNotice: vi.fn(),
    escapeHtml: (s) => String(s),
    // Our fork's stale-session guard (#667) is a required dependency; batch
    // tests aren't exercising it, so default every session to canonical.
    isCanonicalSession: () => true,
    log: silentLog,
    ...overrides,
  };
  return { route: createJournalMediaRouter(deps), deps };
}

const session = { claudeSessionId: 'convo-1', roomId: '!r:s' };
const ctx = { username: 'dan' };

function frame(name, batch, extra = {}) {
  return {
    type: 'image', blobRef: `blob-${name}`, contentType: 'image/png',
    name, batch, ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createJournalMediaRouter — multi-attachment batches', () => {
  it('gathers a complete batch into ONE injection, in index order, with the caption on the front', async () => {
    const { route, deps } = makeRouter({
      buildSavedBlocks: vi.fn((sess, { name, caption }) => (
        caption
          ? [{ type: 'text', text: caption }, { type: 'text', text: `saved:${name}` }]
          : [{ type: 'text', text: `saved:${name}` }]
      )),
    });

    await route(session, frame('a.png', { id: 'B1', index: 1, total: 2 }, { caption: 'compare these' }), ctx);
    // The first frame alone must not inject — that's the exact bug this
    // path exists to close (it would start a turn the second frame queues
    // behind).
    expect(deps.injectBlocks).not.toHaveBeenCalled();

    await route(session, frame('b.png', { id: 'B1', index: 2, total: 2 }), ctx);

    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1]).toEqual([
      { type: 'text', text: 'compare these' },
      { type: 'text', text: 'saved:a.png' },
      { type: 'text', text: 'saved:b.png' },
    ]);
    expect(deps.queueMedia).not.toHaveBeenCalled();
  });

  it('orders the combined injection by batch index even when frames settle out of order', async () => {
    const { route, deps } = makeRouter();

    await route(session, frame('second.png', { id: 'B2', index: 2, total: 2 }), ctx);
    await route(session, frame('first.png', { id: 'B2', index: 1, total: 2 }), ctx);

    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text))
      .toEqual(['saved:first.png', 'saved:second.png']);
  });

  it('a busy session queues the whole batch as ONE entry (single tile, mirrorToJournal:false)', async () => {
    const busySession = { claudeSessionId: 'convo-1', roomId: '!r:s', busy: true };
    const { route, deps } = makeRouter();

    await route(busySession, frame('a.png', { id: 'B3', index: 1, total: 2 }), ctx);
    await route(busySession, frame('b.png', { id: 'B3', index: 2, total: 2 }), ctx);

    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.queueMedia).toHaveBeenCalledTimes(1);
    const [, entry] = deps.queueMedia.mock.calls[0];
    expect(entry).toMatchObject({
      mirrorToJournal: false,
      preview: '2 attachments',
      fullText: 'a.png, b.png',
    });
    expect(entry.blocks.map((b) => b.text)).toEqual(['saved:a.png', 'saved:b.png']);
  });

  it('a failed frame settles its slot: the batch completes with the survivors, no quiet-window wait', async () => {
    const fetchMedia = vi.fn()
      .mockImplementationOnce(async () => null) // first frame's blob unfetchable
      .mockImplementationOnce(async () => ({ buffer: Buffer.from('ok'), contentType: 'image/png' }));
    const { route, deps } = makeRouter({ fetchMedia });

    await route(session, frame('lost.png', { id: 'B4', index: 1, total: 2 }), ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/fetch/));

    await route(session, frame('ok.png', { id: 'B4', index: 2, total: 2 }), ctx);
    // Completed at the second deposit — no timer needed.
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text)).toEqual(['saved:ok.png']);
  });

  it('an incomplete batch delivers what arrived after the quiet window (the rest was never uploaded)', async () => {
    vi.useFakeTimers();
    const { route, deps } = makeRouter({ batchQuietMs: 5_000 });

    await route(session, frame('only.png', { id: 'B5', index: 1, total: 3 }), ctx);
    expect(deps.injectBlocks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text)).toEqual(['saved:only.png']);
  });

  it('each new frame resets the quiet window (slow sequential uploads keep the batch alive)', async () => {
    vi.useFakeTimers();
    const { route, deps } = makeRouter({ batchQuietMs: 5_000 });

    await route(session, frame('a.png', { id: 'B6', index: 1, total: 3 }), ctx);
    await vi.advanceTimersByTimeAsync(4_000);
    await route(session, frame('b.png', { id: 'B6', index: 2, total: 3 }), ctx);
    await vi.advanceTimersByTimeAsync(4_000);
    // 8s since the first frame, but only 4s since the last — still waiting.
    expect(deps.injectBlocks).not.toHaveBeenCalled();

    await route(session, frame('c.png', { id: 'B6', index: 3, total: 3 }), ctx);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text))
      .toEqual(['saved:a.png', 'saved:b.png', 'saved:c.png']);
  });

  it('a redelivered duplicate does NOT reset the quiet window (replays cannot defer partial delivery)', async () => {
    vi.useFakeTimers();
    const { route, deps } = makeRouter({ batchQuietMs: 5_000 });

    await route(session, frame('a.png', { id: 'B6b', index: 1, total: 3 }), ctx);
    await vi.advanceTimersByTimeAsync(4_000);
    // The same index again — a cursor replay, not a new frame. The window
    // measures silence in NEW frames, so this must not push delivery out.
    await route(session, frame('a.png', { id: 'B6b', index: 1, total: 3 }), ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text)).toEqual(['saved:a.png']);
  });

  it('a redelivered frame (cursor replay) does not double its blocks', async () => {
    const { route, deps } = makeRouter();

    await route(session, frame('a.png', { id: 'B7', index: 1, total: 2 }), ctx);
    await route(session, frame('a.png', { id: 'B7', index: 1, total: 2 }), ctx);
    await route(session, frame('b.png', { id: 'B7', index: 2, total: 2 }), ctx);

    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text))
      .toEqual(['saved:a.png', 'saved:b.png']);
  });

  it('batches are keyed per conversation — the same batch id on two convos never mixes', async () => {
    const other = { claudeSessionId: 'convo-2', roomId: '!o:s' };
    const { route, deps } = makeRouter();

    await route(session, frame('mine-1.png', { id: 'B8', index: 1, total: 2 }), ctx);
    await route(other, frame('theirs-1.png', { id: 'B8', index: 1, total: 2 }), ctx);
    expect(deps.injectBlocks).not.toHaveBeenCalled();

    await route(session, frame('mine-2.png', { id: 'B8', index: 2, total: 2 }), ctx);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][0]).toBe(session);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text))
      .toEqual(['saved:mine-1.png', 'saved:mine-2.png']);
  });

  it('an audio frame in a batch delivers its transcript separately and settles its slot', async () => {
    const fetchMedia = vi.fn()
      .mockImplementationOnce(async () => ({ buffer: Buffer.from('ogg'), contentType: 'audio/ogg' }))
      .mockImplementationOnce(async () => ({ buffer: Buffer.from('img'), contentType: 'image/png' }));
    const { route, deps } = makeRouter({ fetchMedia });

    await route(session, frame('memo.ogg', { id: 'B9', index: 1, total: 2 }, { contentType: 'audio/ogg' }), ctx);
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: hello world');

    await route(session, frame('pic.png', { id: 'B9', index: 2, total: 2 }), ctx);
    // The image doesn't wait out the quiet window for the audio slot.
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text)).toEqual(['saved:pic.png']);
  });

  it('a malformed tag degrades to the per-frame path (index out of range, total of 1, oversized total)', async () => {
    const { route, deps } = makeRouter();

    await route(session, frame('a.png', { id: 'B10', index: 3, total: 2 }), ctx);
    await route(session, frame('b.png', { id: 'B10', index: 1, total: 1 }), ctx);
    await route(session, frame('c.png', { id: 'B10', index: 1, total: 26 }), ctx);
    await route(session, frame('d.png', { id: '', index: 1, total: 2 }), ctx);

    // Each injected immediately, exactly like an untagged frame.
    expect(deps.injectBlocks).toHaveBeenCalledTimes(4);
  });

  it('a batch whose every frame failed injects nothing and leaves only the per-frame notices', async () => {
    const { route, deps } = makeRouter({ fetchMedia: vi.fn(async () => null) });

    await route(session, frame('a.png', { id: 'B11', index: 1, total: 2 }), ctx);
    await route(session, frame('b.png', { id: 'B11', index: 2, total: 2 }), ctx);

    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.queueMedia).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledTimes(2);
  });

  it('a straggler after a quiet-window flush injects immediately — no second window', async () => {
    vi.useFakeTimers();
    const { route, deps } = makeRouter({ batchQuietMs: 5_000 });

    await route(session, frame('a.png', { id: 'B13', index: 1, total: 3 }), ctx);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1); // partial flush of a.png

    // The upload of b.png finally lands, long after its siblings flushed.
    // It must not open a fresh gather that can never reach total=3 and sit
    // out another whole quiet window — it delivers per-frame, now.
    await route(session, frame('b.png', { id: 'B13', index: 2, total: 3 }), ctx);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(2);
    expect(deps.injectBlocks.mock.calls[1][1].map((b) => b.text)).toEqual(['saved:b.png']);
  });

  it('a frame replayed after its batch completed injects per-frame, not into a new gather', async () => {
    // Cursor replay after completion: the same duplication a replayed
    // UNTAGGED frame produces today — parity, not a regression — but it
    // must arrive immediately rather than open a doomed gather.
    const { route, deps } = makeRouter();

    await route(session, frame('a.png', { id: 'B14', index: 1, total: 2 }), ctx);
    await route(session, frame('b.png', { id: 'B14', index: 2, total: 2 }), ctx);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);

    await route(session, frame('a.png', { id: 'B14', index: 1, total: 2 }), ctx);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(2);
    expect(deps.injectBlocks.mock.calls[1][1].map((b) => b.text)).toEqual(['saved:a.png']);
  });

  it('a conflicting total for an open batch routes that frame per-frame and leaves the gather intact', async () => {
    vi.useFakeTimers();
    const { route, deps } = makeRouter({ batchQuietMs: 5_000 });

    await route(session, frame('a.png', { id: 'B15', index: 1, total: 2 }), ctx);
    // Malformed client: same id, different total. It must not redefine
    // completion for the open entry (total 3 would finalize at 2/2 of the
    // WRONG contract) — the conflicting frame delivers immediately instead.
    await route(session, frame('x.png', { id: 'B15', index: 2, total: 3 }), ctx);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text)).toEqual(['saved:x.png']);

    // The open entry keeps its own contract: its second frame completes it.
    await route(session, frame('b.png', { id: 'B15', index: 2, total: 2 }), ctx);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(2);
    expect(deps.injectBlocks.mock.calls[1][1].map((b) => b.text))
      .toEqual(['saved:a.png', 'saved:b.png']);
  });

  it('batch ids containing the old delimiter cannot collide across conversations', async () => {
    // Structural key regression pin: convo 'a|b' + id 'c' must never share
    // a gather with convo 'a' + id 'b|c'.
    const weird = { claudeSessionId: 'a|b', roomId: '!w:s' };
    const plain = { claudeSessionId: 'a', roomId: '!p:s' };
    const { route, deps } = makeRouter();

    await route(weird, frame('w1.png', { id: 'c', index: 1, total: 2 }), ctx);
    await route(plain, frame('p1.png', { id: 'b|c', index: 2, total: 2 }), ctx);
    // If the keys collided, the second deposit would have completed a mixed
    // batch. Neither gather is complete, so nothing injects.
    expect(deps.injectBlocks).not.toHaveBeenCalled();
  });

  it('the quiet window does NOT finalize while a sibling video is still extracting (slow buildVideoBlocks)', async () => {
    // The race batching exists to prevent: an image deposits and arms the
    // quiet timer, then its sibling video spends longer than the window
    // inside ffmpeg/whisper. The window measures silence in UPLOADS — a
    // frame already in flight is by definition not silence — so the timer
    // must be parked until the video settles, and the batch must deliver as
    // ONE injection.
    vi.useFakeTimers();
    const fetchMedia = vi.fn()
      .mockImplementationOnce(async () => ({ buffer: Buffer.from('img'), contentType: 'image/png' }))
      .mockImplementationOnce(async () => ({ buffer: Buffer.from('mov'), contentType: 'video/quicktime' }));
    const buildVideoBlocks = vi.fn(async () => {
      // Extraction outlives the whole quiet window (fake-timer controlled).
      await new Promise((resolve) => { setTimeout(resolve, 8_000); });
      return [{ type: 'text', text: 'frames:clip.mov' }];
    });
    const { route, deps } = makeRouter({ batchQuietMs: 5_000, fetchMedia, buildVideoBlocks });

    await route(session, frame('a.png', { id: 'BV1', index: 1, total: 2 }), ctx);
    expect(deps.injectBlocks).not.toHaveBeenCalled();

    const videoRoute = route(session,
      frame('clip.mov', { id: 'BV1', index: 2, total: 2 }, { contentType: 'video/quicktime' }), ctx);
    // Walk time well past the quiet window while extraction is running.
    await vi.advanceTimersByTimeAsync(8_000);
    await videoRoute;

    // One combined injection — never a partial flush of a.png at 5s plus the
    // video arriving later as a separate turn.
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text))
      .toEqual(['saved:a.png', 'frames:clip.mov']);
  });

  it('a settled slow frame restarts the quiet window — the parked timer cannot stall an incomplete batch', async () => {
    // The hold must be a pause, not a hole: once the slow video deposits and
    // the batch is STILL incomplete (a third frame never uploads), the quiet
    // window resumes and partial delivery happens as designed.
    vi.useFakeTimers();
    const fetchMedia = vi.fn()
      .mockImplementationOnce(async () => ({ buffer: Buffer.from('img'), contentType: 'image/png' }))
      .mockImplementationOnce(async () => ({ buffer: Buffer.from('mov'), contentType: 'video/quicktime' }));
    const buildVideoBlocks = vi.fn(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 8_000); });
      return [{ type: 'text', text: 'frames:clip.mov' }];
    });
    const { route, deps } = makeRouter({ batchQuietMs: 5_000, fetchMedia, buildVideoBlocks });

    await route(session, frame('a.png', { id: 'BV2', index: 1, total: 3 }), ctx);
    const videoRoute = route(session,
      frame('clip.mov', { id: 'BV2', index: 2, total: 3 }, { contentType: 'video/quicktime' }), ctx);
    await vi.advanceTimersByTimeAsync(8_000);
    await videoRoute;
    // Video settled, batch still 2/3 — window restarted, not yet expired.
    expect(deps.injectBlocks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
    expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text))
      .toEqual(['saved:a.png', 'frames:clip.mov']);
  });

  it('busy-ness is read when the batch completes, not when it started gathering', async () => {
    // Turn ends while the batch is still uploading: the batch must inject
    // immediately at completion, not queue against a busy flag that is no
    // longer true (the mirror of the single-frame delivery-time rule).
    const flippingSession = { claudeSessionId: 'convo-1', roomId: '!r:s', busy: true };
    const { route, deps } = makeRouter();

    await route(flippingSession, frame('a.png', { id: 'B12', index: 1, total: 2 }), ctx);
    flippingSession.busy = false;
    await route(flippingSession, frame('b.png', { id: 'B12', index: 2, total: 2 }), ctx);

    expect(deps.queueMedia).not.toHaveBeenCalled();
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
  });

  it('a sibling whose download never completes cannot stall the batch forever (fetch abort deadline)', async () => {
    // The in-flight hold parks the quiet timer for the whole of a frame's
    // processing, which is only safe because every step of that processing is
    // itself bounded. A blob fetch that hangs in the body read (server wrote
    // headers, then the connection went dead) is the one step that used to
    // have no ceiling: the hold was never released, the quiet timer never
    // re-armed, and the sibling frame that HAD arrived was never delivered.
    // Driven through the real publisher.fetchMedia — an injected mock can't
    // exercise the deadline that lives inside it.
    const blobs = await startStallingBlobServer({ 'blob-ok.png': Buffer.from('img') });
    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${blobs.port}/ws`,
      token: 'tok',
      log: silentLog,
      backoffBaseMs: 15,
      backoffCapMs: 60,
      fetchMediaTimeoutMs: 200,
    });
    // A quiet window far longer than the test: delivery here can only come
    // from the stalled frame settling, never from the partial-batch timer.
    const { route, deps } = makeRouter({ fetchMedia: pub.fetchMedia, batchQuietMs: 600_000 });

    try {
      await route(session, frame('ok.png', { id: 'BS1', index: 1, total: 2 }), ctx);
      expect(deps.injectBlocks).not.toHaveBeenCalled();

      const stalled = route(session, frame('stall.png', { id: 'BS1', index: 2, total: 2 }), ctx);
      const outcome = await Promise.race([
        stalled.then(() => 'settled'),
        delay(3_000).then(() => 'hung'),
      ]);
      expect(outcome).toBe('settled');

      // The stalled frame deposited null, which completed the batch: the
      // frame that did arrive reaches claude, and the user is told about the
      // one that didn't.
      expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
      expect(deps.injectBlocks.mock.calls[0][1].map((b) => b.text)).toEqual(['saved:ok.png']);
      expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/fetch/));
    } finally {
      pub.close();
      await blobs.close();
    }
  });
});
