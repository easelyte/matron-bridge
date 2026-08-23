import { describe, it, expect } from 'vitest';
import { queueFlushNotice } from '../lib/queue-flush-notice.js';

// These are GOLDEN tests. Every string below was transcribed from the four
// call sites as they stood on b752b6d, before the wording was pulled into
// lib/queue-flush-notice.js — index.js flushPendingSessionQueue (turn end),
// lib/busy-queue.js handleBusyQueueMagicWord (typed `send`), lib/busy-queue.js
// resolveQueueReleaseTap (journal card tap), and the index.js /interrupt
// endpoint. The extraction was required to be byte-for-byte invisible to the
// user, so these assert whole strings rather than fragments: a `toMatch` on a
// fragment would not have caught a lost newline, a dropped `<b>`, or the em
// dash turning into a hyphen.
//
// Two of those four sites live in index.js and so could only ever be pinned by
// source inspection. This file is the first behavioural coverage their
// announcements have had.

const summary = {
  plain: '  1. first message\n  2. second message',
  html: '<ol><li>first message</li><li>second message</li></ol>',
};

describe('queueFlushNotice — turnEnd (the flush the user did not ask for)', () => {
  it('lists the batch, plain', () => {
    expect(queueFlushNotice('turnEnd', { queued: 2, summary }).plain)
      .toBe('📬 Sending 2 queued messages:\n  1. first message\n  2. second message');
  });

  it('lists the batch, html', () => {
    expect(queueFlushNotice('turnEnd', { queued: 2, summary }).html)
      .toBe('<b>📬 Sending 2 queued messages:</b><ol><li>first message</li><li>second message</li></ol>');
  });

  it('says "message" singular for a one-entry batch', () => {
    expect(queueFlushNotice('turnEnd', { queued: 1, summary }).plain)
      .toBe('📬 Sending 1 queued message:\n  1. first message\n  2. second message');
  });

  // A compact split explains why the rest were held instead of listing what
  // went; without it the held messages read as swallowed.
  it('a compact split explains the hold rather than listing the batch', () => {
    const n = queueFlushNotice('turnEnd', { queued: 1, deferred: 2, summary });
    expect(n.plain).toBe('📬 Sending /compact first — the other 2 queued messages will be sent once compaction finishes.');
    expect(n.html).toBe('<b>📬 Sending /compact first</b> — the other 2 queued messages will be sent once compaction finishes.');
  });

  it('a compact split holding one message says "message" singular', () => {
    expect(queueFlushNotice('turnEnd', { queued: 1, deferred: 1, summary }).plain)
      .toBe('📬 Sending /compact first — the other 1 queued message will be sent once compaction finishes.');
  });
});

describe('queueFlushNotice — sendNow (magic word, card tap, /interrupt)', () => {
  it('lists the batch, plain', () => {
    expect(queueFlushNotice('sendNow', { queued: 2, summary }).plain)
      .toBe('⚡ Sending 2 queued messages now:\n  1. first message\n  2. second message');
  });

  it('lists the batch, html', () => {
    expect(queueFlushNotice('sendNow', { queued: 2, summary }).html)
      .toBe('<b>⚡ Sending 2 queued messages now:</b><ol><li>first message</li><li>second message</li></ol>');
  });

  it('says "message" singular for a one-entry batch', () => {
    expect(queueFlushNotice('sendNow', { queued: 1, summary }).plain)
      .toBe('⚡ Sending 1 queued message now:\n  1. first message\n  2. second message');
  });

  it('a compact split explains the hold rather than listing the batch', () => {
    const n = queueFlushNotice('sendNow', { queued: 1, deferred: 2, summary });
    expect(n.plain).toBe('⚡ Sending /compact now — the other 2 messages will be sent once compaction finishes.');
    expect(n.html).toBe('<b>⚡ Sending /compact now</b> — the other 2 messages will be sent once compaction finishes.');
  });

  it('a compact split holding one message says "message" singular', () => {
    expect(queueFlushNotice('sendNow', { queued: 1, deferred: 1, summary }).plain)
      .toBe('⚡ Sending /compact now — the other 1 message will be sent once compaction finishes.');
  });
});

// "Send just this one" flushes ONE message and deliberately leaves the rest
// queued with their cards live. That is a different shape from `deferred`,
// which means "held back by a compact split and will be sent automatically" —
// so it gets its own option rather than reusing that noun. Without the tail the
// user sees "⚡ Sending 1 queued message now" with no hint that the other two
// are still waiting, which reads like the rest were dropped.
describe('queueFlushNotice — remaining (send just this one)', () => {
  it('lists the sent message and says how many stay queued', () => {
    expect(queueFlushNotice('sendNow', { queued: 1, summary, remaining: 2 }).plain)
      .toBe('⚡ Sending 1 queued message now:\n  1. first message\n  2. second message\n— the other 2 messages stay queued.');
  });

  it('agrees the verb for a single remaining message', () => {
    expect(queueFlushNotice('sendNow', { queued: 1, summary, remaining: 1 }).plain)
      .toBe('⚡ Sending 1 queued message now:\n  1. first message\n  2. second message\n— the other 1 message stays queued.');
  });

  it('says nothing extra when the queue is now empty', () => {
    expect(queueFlushNotice('sendNow', { queued: 1, summary, remaining: 0 }).plain)
      .toBe('⚡ Sending 1 queued message now:\n  1. first message\n  2. second message');
  });

  it('carries the tail into the html channel too', () => {
    expect(queueFlushNotice('sendNow', { queued: 1, summary, remaining: 2 }).html)
      .toBe('<b>⚡ Sending 1 queued message now:</b><ol><li>first message</li><li>second message</li></ol> — the other 2 messages stay queued.');
  });

  // A compact split is the louder fact and already owns the whole notice; the
  // two are never combined at any call site.
  it('a deferred notice ignores remaining — the compact split takes precedence', () => {
    expect(queueFlushNotice('sendNow', { deferred: 2, remaining: 3 }).plain)
      .toBe('⚡ Sending /compact now — the other 2 messages will be sent once compaction finishes.');
  });
});

describe('queueFlushNotice — cross-style invariants', () => {
  // The two styles differ ONLY in sigil, tense and the deferred noun. Anything
  // else diverging means one of them was edited without the other.
  it('the two styles differ only where they are meant to', () => {
    const te = queueFlushNotice('turnEnd', { queued: 3, summary }).plain;
    const sn = queueFlushNotice('sendNow', { queued: 3, summary }).plain;
    expect(te.replace('📬', '⚡').replace(' messages:', ' messages now:')).toBe(sn);
  });

  // Preserved deliberately from the pre-extraction code: the turn-end hold
  // note says "queued message", the explicit-send one says "message". Kept as
  // a documented difference rather than silently normalised — if this ever
  // fails, the wording was unified on purpose and this test records the change.
  it('the deferred noun still differs between the styles', () => {
    expect(queueFlushNotice('turnEnd', { deferred: 2 }).plain).toContain('the other 2 queued messages');
    expect(queueFlushNotice('sendNow', { deferred: 2 }).plain).toContain('the other 2 messages');
  });

  // The card-tap path has no HTML channel and reads .plain off a notice built
  // without a summary on the deferred branch; neither may throw or leak
  // "undefined" into user-visible text.
  it('a deferred notice needs no summary', () => {
    expect(queueFlushNotice('sendNow', { deferred: 2 }).plain).not.toContain('undefined');
    expect(queueFlushNotice('turnEnd', { deferred: 2 }).html).not.toContain('undefined');
  });

  it('a missing summary degrades to an empty list rather than "undefined"', () => {
    expect(queueFlushNotice('sendNow', { queued: 1 }).plain).toBe('⚡ Sending 1 queued message now:\n');
    expect(queueFlushNotice('sendNow', { queued: 1 }).html).toBe('<b>⚡ Sending 1 queued message now:</b>');
  });

  // A typo'd style must fail loudly at the call site rather than rendering
  // "undefined Sending 2 queued messages:" to the user.
  it('an unknown style throws', () => {
    expect(() => queueFlushNotice('sendLater', { queued: 1, summary })).toThrow(/unknown style/);
  });
});
