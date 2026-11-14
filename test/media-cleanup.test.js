import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJournalMediaRouter } from '../lib/journal-media.js';
import { attachQueuedCleanup, runQueuedCleanup } from '../lib/queue-flush.js';
import { handleBusyQueueMagicWord, resolveQueueReleaseTap, cancelQueuedItem } from '../lib/busy-queue.js';

const blocks = [{ type: 'text', text: 'saved attachment' }];
const media = { type: 'file', blobRef: 'upload', name: 'report.pdf' };
function harness(overrides = {}) {
  const session = { alive: true, agent: 'claude', claudeSessionId: 'provider', journalConvoId: 'conversation', _sessionConfirmed: true };
  const deps = {
    isCanonicalSession: (s) => s === session && s.alive,
    fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('bytes') })),
    buildSavedBlocks: vi.fn(async () => ({ blocks, cleanup: vi.fn() })),
    injectBlocks: vi.fn(() => true), injectText: vi.fn(() => true),
    queueMedia: vi.fn(async () => {}), echoToRoom: vi.fn(), publishNotice: vi.fn(),
    log: { warn: vi.fn() }, ...overrides,
  };
  return { session, deps, route: createJournalMediaRouter(deps) };
}
afterEach(() => vi.useRealTimers());

describe('saved attachment cleanup on delivery', () => {
  it.each(['refused', 'throw', 'empty', 'queue throw'])('cleans saved files after %s delivery', async outcome => {
    const cleanup = vi.fn();
    const h = harness({ buildSavedBlocks: async () => {
      return { blocks: outcome === 'empty' ? [] : blocks, cleanup };
    }, injectBlocks: () => {
      if (outcome === 'throw') throw new Error('send failed');
      return false;
    }, queueMedia: async () => { throw new Error('queue failed'); } });
    h.session.busy = outcome === 'queue throw';
    await h.route(h.session, media);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('retains the file after accepted delivery, busy=%s', async busy => {
    const cleanup = vi.fn();
    const h = harness({ buildSavedBlocks: async () => ({ blocks, cleanup }) });
    h.session.busy = busy;
    await h.route(h.session, media);
    expect(cleanup).not.toHaveBeenCalled();
    if (busy) {
      expect(h.deps.queueMedia.mock.calls[0][1].cleanup).toBe(cleanup);
    } else expect(h.deps.injectBlocks).toHaveBeenCalled();
  });

  it('removes the saved file when the session is replaced while it is being built', async () => {
    const cleanup = vi.fn();
    let h;
    h = harness({ buildSavedBlocks: async () => { h.session.alive = false; return { blocks, cleanup }; } });
    await h.route(h.session, media);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(h.deps.injectBlocks).not.toHaveBeenCalled();
    expect(h.deps.queueMedia).not.toHaveBeenCalled();
  });

  it('removes the parts a batch gathered when the session is replaced before it finalizes', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const h = harness({ buildSavedBlocks: async () => ({ blocks, cleanup }), batchQuietMs: 100 });
    await h.route(h.session, { ...media, batch: { id: 'batch', index: 1, total: 2 } });
    h.session.alive = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(h.deps.injectBlocks).not.toHaveBeenCalled();
  });

  it('cleans a duplicate batch frame and an undeliverable partial batch', async () => {
    vi.useFakeTimers();
    const cleanups = [vi.fn(), vi.fn()];
    const h = harness({ buildSavedBlocks: vi.fn()
      .mockResolvedValueOnce({ blocks, cleanup: cleanups[0] })
      .mockResolvedValueOnce({ blocks, cleanup: cleanups[1] }), batchQuietMs: 100 });
    const frame = { ...media, batch: { id: 'batch', index: 1, total: 2 } };
    await h.route(h.session, frame);
    await h.route(h.session, frame);
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
    h.deps.injectBlocks.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
  });

  it('passes every saved-file cleanup to a completed busy batch', async () => {
    const cleanup = vi.fn();
    const h = harness({ buildSavedBlocks: async () => ({ blocks, cleanup }) });
    h.session.busy = true;
    for (const index of [1, 2]) await h.route(h.session, { ...media, batch: { id: 'batch', index, total: 2 } });
    expect(cleanup).not.toHaveBeenCalled();
    h.deps.queueMedia.mock.calls[0][1].cleanup();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('cleans saved files when the session ended while the attachment was being prepared', async () => {
    const cleanup = vi.fn();
    const h = harness({ buildSavedBlocks: async () => {
      h.session.alive = false;
      return { blocks, cleanup };
    }, injectBlocks: vi.fn(() => false) });
    h.session.busy = true;
    await h.route(h.session, media);
    expect(h.deps.queueMedia).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans video frames when delivery is refused', async () => {
    const cleanup = vi.fn();
    const h = harness({ buildVideoBlocks: async () => ({ blocks, cleanup }), injectBlocks: vi.fn(() => false) });
    await h.route(h.session, { ...media, contentType: 'video/mp4' });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('queued attachment cancellation', () => {
  it('carries cleanup without serializing it and runs it once despite errors', () => {
    const cleanup = vi.fn(() => { throw new Error('disk unavailable'); });
    const entry = attachQueuedCleanup([...blocks], cleanup);
    expect(JSON.stringify(entry)).toBe(JSON.stringify(blocks));
    expect(runQueuedCleanup(entry)).toBe(true);
    expect(runQueuedCleanup(entry)).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(['magic', 'tap', 'item'])('cleans the file on %s cancellation', async kind => {
    const cleanup = vi.fn();
    const session = { queuedMessages: [attachQueuedCleanup([...blocks], cleanup)], queueNotifications: [{ id: 'card::0' }] };
    const deps = { sendReply: vi.fn(), sendHtml: vi.fn(), htmlEscape: s => s,
      queueRelease: { listLive: () => [{ itemId: 'card::0', promptId: 'card' }], dropItem: vi.fn() },
      convoId: 'conversation', emitRelease: (_convo, _entry, { mutate } = {}) => { mutate?.(); return true; } };
    if (kind === 'magic') await handleBusyQueueMagicWord(session, 'cancel', deps);
    if (kind === 'tap') resolveQueueReleaseTap('cancel:0', session, deps);
    if (kind === 'item') cancelQueuedItem(session, { itemId: 'card::0', promptId: 'card', ...deps });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('stale Codex steer wiring', () => {
  it('marks the batch handed off in killSession and honours it in both stale branches', async () => {
    const { readFileSync } = await import('node:fs');
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(index).toContain('session._codexSteerPending.handedOff = true;');
    const start = index.indexOf('const steerPending = {');
    const steer = index.slice(start, index.indexOf("return 'deferred';", start));
    expect(steer.match(/steerPending\.handedOff/g)).toHaveLength(2);
  });
});
