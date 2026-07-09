import { describe, it, expect } from 'vitest';
import { makeFlusher } from '../lib/coalesce-flush-kit.js';

describe('_flushCoalesceBuffer', () => {
  it('dispatches one turn when idle', async () => {
    const sends = [];
    const queued = [];
    const session = { busy: false, firstMessageCaptured: true };
    const flush = makeFlusher({
      downloadAndMerge: async () => [{ type: 'text', text: 'x' }],
      sendToSession: (s, m) => { sends.push(m); s.busy = true; return true; },
      queue: (s, m) => queued.push(m),
    });

    await flush(session, [{ event: {}, meta: { msgtype: 'm.text' } }]);

    expect(sends).toEqual([[{ type: 'text', text: 'x' }]]);
    expect(queued).toEqual([]);
  });

  it('routes to queue when busy at dispatch', async () => {
    const sends = [];
    const queued = [];
    const session = { busy: true, firstMessageCaptured: true };
    const flush = makeFlusher({
      downloadAndMerge: async () => [{ type: 'text', text: 'y' }],
      sendToSession: (s, m) => { sends.push(m); return true; },
      queue: (s, m) => queued.push(m),
    });

    await flush(session, [{ event: {}, meta: { msgtype: 'm.text' } }]);

    expect(sends).toEqual([]);
    expect(queued).toEqual([[{ type: 'text', text: 'y' }]]);
  });

  it('no-ops on an all-failed empty merge', async () => {
    const sends = [];
    const cleared = [];
    const session = { busy: false, firstMessageCaptured: true };
    const flush = makeFlusher({
      downloadAndMerge: async () => [],
      sendToSession: (s, m) => { sends.push(m); return true; },
      queue: () => {},
      clearTyping: (s) => cleared.push(s),
    });

    await flush(session, [{ event: {}, meta: { msgtype: 'm.image', name: 'x' } }]);

    expect(sends).toEqual([]);
    expect(cleared).toEqual([session]);
  });

  it('lazily initializes the real busy queue shape', async () => {
    const session = { busy: true, firstMessageCaptured: true };
    const flush = makeFlusher({
      downloadAndMerge: async () => [{ type: 'text', text: 'queued' }],
      sendToSession: () => { throw new Error('should not send while busy'); },
    });

    await flush(session, [{ event: {}, meta: { msgtype: 'm.text' } }]);

    expect(session.queuedMessages).toEqual([[{ type: 'text', text: 'queued' }]]);
  });

  it('checks sendToSession failure and sends a visible room notice', async () => {
    const unavailable = [];
    const session = { busy: false, firstMessageCaptured: true };
    const flush = makeFlusher({
      downloadAndMerge: async () => [{ type: 'text', text: 'z' }],
      sendToSession: () => false,
      sendUnavailable: async (s) => unavailable.push(s),
    });

    await flush(session, [{ event: {}, meta: { msgtype: 'm.text' } }]);

    expect(unavailable).toEqual([session]);
  });

  it('persists ONLY user-authored text to history, not media-derived blocks (Phase-2 review B2)', async () => {
    const history = [];
    const session = { busy: false, firstMessageCaptured: true };
    const flush = makeFlusher({
      // merged burst = user text + a text-file's full contents; only the user text may persist
      downloadAndMerge: async () => [
        { type: 'text', text: 'look at this' },
        { type: 'text', text: 'Contents of secrets.csv:\napi_key,SECRET123' },
      ],
      sendToSession: () => true,
      appendHistory: (s, t) => history.push(t),
    });

    await flush(session, [
      { event: { content: { body: 'look at this' } }, meta: { msgtype: 'm.text' } },
      { event: { content: { body: 'secrets.csv' } }, meta: { msgtype: 'm.file', name: 'secrets.csv' } },
    ]);

    // history carries the user message only; the file contents are NOT persisted
    expect(history).toEqual(['look at this']);
  });

  it('catches flush failures, queues a fail-visible block, and notifies the room', async () => {
    const errors = [];
    const notices = [];
    const session = { busy: false, firstMessageCaptured: true };
    const flush = makeFlusher({
      downloadAndMerge: async () => { throw new Error('boom'); },
      sendToSession: () => true,
      sendFailureNotice: async (s) => notices.push(s),
      onError: (err) => errors.push(err.message),
    });

    await flush(session, [{ event: {}, meta: { msgtype: 'm.image', name: 'x' } }]);

    expect(errors).toEqual(['boom']);
    expect(session.queuedMessages).toEqual([[{ type: 'text', text: "⚠️ Couldn't process that burst — resend to retry" }]]);
    expect(notices).toEqual([session]);
  });
});
