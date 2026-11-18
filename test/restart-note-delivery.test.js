import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createNoteDelivery, NOTE_FIRST_DELAY_MS, NOTE_RETRY_MS, NOTE_MAX_ATTEMPTS,
} from '../lib/restart-note-delivery.js';
import { createRestartNotes, takeNoteDeliveries } from '../lib/restart-notes.js';

const NOW = 1_800_000_000_000;

// A manual scheduler: timers run when the test says so, in due order.
function clock() {
  const state = { t: 0, timers: [] };
  const schedule = (fn, ms) => { const timer = { at: state.t + ms, fn }; state.timers.push(timer); return timer; };
  const cancelTimer = (timer) => { state.timers = state.timers.filter(x => x !== timer); };
  const advance = async (ms) => {
    const end = state.t + ms;
    for (;;) {
      state.timers.sort((a, b) => a.at - b.at);
      const next = state.timers[0];
      if (!next || next.at > end) break;
      state.timers.shift();
      state.t = next.at;
      next.fn();
      // Let the async attempt settle before the next timer.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    state.t = end;
  };
  return { state, schedule, cancelTimer, advance, now: () => NOW + state.t };
}

const note = (convoId, extra = {}) => ({ convoId, text: `note for ${convoId}`, writtenAt: 1, ageMs: 0, interrupted: false, ...extra });
const key = (n) => ({ convoId: n.convoId, writtenAt: n.writtenAt });

// results: per-convo list of outcomes for deliver, in order.
function setup(results, opts = {}) {
  const c = clock();
  const calls = [];
  const cards = [];
  const discards = [];
  const logs = [];
  const queue = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, [...v]]));
  const delivery = createNoteDelivery({
    deliver: async (n) => { calls.push({ ...n, at: c.state.t }); const r = queue[n.convoId].shift(); if (r instanceof Error) throw r; return r; },
    recover: (n) => { cards.push(n.convoId); if (opts.recoverThrows) throw new Error('card failed'); return opts.cardPublished === false ? false : true; },
    discard: (entries) => { discards.push(entries); if (opts.discardThrows) throw new Error('EACCES'); },
    schedule: c.schedule, cancelTimer: c.cancelTimer, now: c.now, log: (m) => logs.push(m),
  });
  return { c, calls, cards, discards, logs, delivery };
}

describe('resume note delivery', () => {
  it('delivers once after the first delay and then removes that note', async () => {
    const t = setup({ a: [true] });
    const a = note('a');
    t.delivery.start([a], [key(a)]);
    expect(t.calls).toHaveLength(0);
    await t.c.advance(NOTE_FIRST_DELAY_MS);
    expect(t.calls).toHaveLength(1);
    expect(t.cards).toEqual([]);
    expect(t.discards).toEqual([[a]]);
    await t.c.advance(10 * NOTE_RETRY_MS);
    expect(t.calls).toHaveLength(1);
  });

  it('retries a failed delivery after the backoff and keeps the note until it works', async () => {
    const t = setup({ a: [false, true] });
    t.delivery.start([note('a')], [key(note('a'))]);
    await t.c.advance(NOTE_FIRST_DELAY_MS);
    expect(t.calls).toHaveLength(1);
    expect(t.discards).toEqual([]);
    await t.c.advance(NOTE_RETRY_MS - 1);
    expect(t.calls).toHaveLength(1);
    await t.c.advance(1);
    expect(t.calls).toHaveLength(2);
    expect(t.discards).toHaveLength(1);
    expect(t.cards).toEqual([]);
  });

  it('counts a throw and a non-true result as failures, and numbers the attempts', async () => {
    const t = setup({ a: [new Error('boom'), undefined, true] });
    t.delivery.start([note('a')], []);
    await t.c.advance(NOTE_FIRST_DELAY_MS + 2 * NOTE_RETRY_MS);
    expect(t.calls.map(c => c.attempt)).toEqual([1, 2, 3]);
    expect(t.cards).toEqual([]);
    expect(t.discards).toHaveLength(1);
  });

  it('publishes the Carry on card after the last attempt and then removes the note', async () => {
    const t = setup({ a: [false, false, false] });
    t.delivery.start([note('a')], [key(note('a'))]);
    await t.c.advance(NOTE_FIRST_DELAY_MS + (NOTE_MAX_ATTEMPTS - 1) * NOTE_RETRY_MS);
    expect(t.calls).toHaveLength(NOTE_MAX_ATTEMPTS);
    expect(t.cards).toEqual(['a']);
    expect(t.discards).toEqual([[note('a')]]);
    await t.c.advance(10 * NOTE_RETRY_MS);
    expect(t.calls).toHaveLength(NOTE_MAX_ATTEMPTS);
  });

  it('keeps the note when the card was not published (false) or threw', async () => {
    for (const opts of [{ cardPublished: false }, { recoverThrows: true }]) {
      const t = setup({ a: [false, false, false] }, opts);
      t.delivery.start([note('a')], []);
      await t.c.advance(NOTE_FIRST_DELAY_MS + 2 * NOTE_RETRY_MS);
      expect(t.cards).toEqual(['a']);
      expect(t.discards).toEqual([]);
      expect(t.logs.join('\n')).toMatch(/keeping the note for the next boot/);
    }
  });

  it('removes each note as soon as it is dealt with, not when the others settle', async () => {
    const t = setup({ a: [true], b: [false, false, false] });
    const a = note('a');
    const b = note('b', { writtenAt: 2 });
    t.delivery.start([a, b], [key(a), key(b)]);
    await t.c.advance(NOTE_FIRST_DELAY_MS);
    expect(t.calls.map(c => c.convoId)).toEqual(['a', 'b']);
    // A is gone from disk while B is still failing: a restart now cannot redeliver A.
    expect(t.discards).toEqual([[a]]);
    await t.c.advance(2 * NOTE_RETRY_MS);
    expect(t.discards).toEqual([[a], [b]]);
  });

  it('measures the note age at the time of each attempt', async () => {
    const t = setup({ a: [false, true] });
    t.delivery.start([note('a', { ageMs: 5_000 })], []);
    await t.c.advance(NOTE_FIRST_DELAY_MS + NOTE_RETRY_MS);
    expect(t.calls[0].ageMs).toBe(5_000 + NOTE_FIRST_DELAY_MS);
    expect(t.calls[1].ageMs).toBe(5_000 + NOTE_FIRST_DELAY_MS + NOTE_RETRY_MS);
  });

  it('removes the notes it was not asked to deliver (dropped ones) straight away', () => {
    const t = setup({});
    const gone = { convoId: 'gone', writtenAt: 1 };
    t.delivery.start([], [gone]);
    expect(t.discards).toEqual([[gone]]);
  });

  it('a failed removal is logged, not thrown', async () => {
    const t = setup({ a: [true] }, { discardThrows: true });
    t.delivery.start([note('a')], []);
    await t.c.advance(NOTE_FIRST_DELAY_MS);
    expect(t.logs.join('\n')).toMatch(/could not remove the delivered note for convo=a: EACCES/);
  });

  it('stop() cancels the pending retries: nothing is delivered, carded or removed afterwards', async () => {
    const t = setup({ a: [false, true] });
    t.delivery.start([note('a')], [key(note('a'))]);
    await t.c.advance(NOTE_FIRST_DELAY_MS);
    expect(t.calls).toHaveLength(1);
    t.delivery.stop();
    await t.c.advance(10 * NOTE_RETRY_MS);
    expect(t.calls).toHaveLength(1);
    expect(t.cards).toEqual([]);
    expect(t.discards).toEqual([]);
  });

  it('halted() cancels the pending retries and ignores an attempt in flight, without stop()', async () => {
    let down = false;
    const t = setup({ a: [false, true] });
    const c = clock();
    const calls = [];
    const cards = [];
    const discards = [];
    const delivery = createNoteDelivery({
      deliver: async (n) => { calls.push(n.attempt); return false; },
      recover: (n) => { cards.push(n.convoId); return true; },
      discard: (e) => discards.push(e),
      schedule: c.schedule, cancelTimer: c.cancelTimer, halted: () => down, now: c.now,
    });
    delivery.start([note('a')], []);
    await c.advance(NOTE_FIRST_DELAY_MS);
    expect(calls).toEqual([1]);
    down = true;
    await c.advance(10 * NOTE_RETRY_MS);
    expect(calls).toEqual([1]);
    expect(cards).toEqual([]);
    expect(discards).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('stop() during a delivery in flight: its result is ignored (no card, no removal)', async () => {
    const c = clock();
    const cards = [];
    const discards = [];
    let release;
    const delivery = createNoteDelivery({
      deliver: () => new Promise((resolve) => { release = resolve; }),
      recover: (n) => { cards.push(n.convoId); return true; },
      discard: (e) => discards.push(e),
      schedule: c.schedule, cancelTimer: c.cancelTimer, now: c.now, maxAttempts: 1,
    });
    delivery.start([note('a')], []);
    await c.advance(NOTE_FIRST_DELAY_MS);
    delivery.stop();
    release(false);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(cards).toEqual([]);
    expect(discards).toEqual([]);
  });
});

describe('resume note delivery at shutdown', () => {
  it('a send in flight that succeeds after halted() still removes its note', async () => {
    let down = false;
    const c = clock();
    const discards = [];
    let release;
    const delivery = createNoteDelivery({
      deliver: () => new Promise((resolve) => { release = resolve; }),
      discard: (e) => discards.push(e),
      schedule: c.schedule, cancelTimer: c.cancelTimer, halted: () => down, now: c.now,
    });
    delivery.start([note('a')], []);
    await c.advance(NOTE_FIRST_DELAY_MS);
    down = true;
    release(true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(discards).toHaveLength(1);
    expect(discards[0][0].convoId).toBe('a');
  });

  it('a send in flight that succeeds after stop() still removes its note', async () => {
    const c = clock();
    const discards = [];
    let release;
    const delivery = createNoteDelivery({
      deliver: () => new Promise((resolve) => { release = resolve; }),
      discard: (e) => discards.push(e),
      schedule: c.schedule, cancelTimer: c.cancelTimer, now: c.now,
    });
    delivery.start([note('a')], []);
    await c.advance(NOTE_FIRST_DELAY_MS);
    delivery.stop();
    release(true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(discards).toHaveLength(1);
  });
});

describe('resume note delivery against the real note store', () => {
  function tmpStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-delivery-'));
    const file = path.join(dir, 'notes.json');
    return { file, store: createRestartNotes({ file, now: () => NOW }) };
  }

  // One boot: peek the notes, choose deliveries, deliver with `results`.
  async function boot(store, results, { crashBeforeRemoval = false } = {}) {
    const c = clock();
    let taken = [];
    const { deliveries } = takeNoteDeliveries({
      store: { take: () => { taken = store.peek(); return taken; } },
      stale: [], resumable: new Set(['c1', 'c2']), now: () => NOW,
    });
    const delivered = [];
    const cards = [];
    const delivery = createNoteDelivery({
      deliver: async (n) => { delivered.push(n.convoId); return results.shift(); },
      recover: (n) => { cards.push(n.convoId); return true; },
      discard: crashBeforeRemoval ? () => { throw new Error('crashed before the note was removed'); } : (entries) => store.discard(entries),
      schedule: c.schedule, cancelTimer: c.cancelTimer, now: c.now,
    });
    delivery.start(deliveries, taken);
    await c.advance(NOTE_FIRST_DELAY_MS + NOTE_MAX_ATTEMPTS * NOTE_RETRY_MS);
    return { delivered, cards };
  }

  it('a crash before delivery delivers the note exactly once at the next boot', async () => {
    const { store } = tmpStore();
    store.put('c1', 'carry on with the migration');
    // First boot dies before any timer fires: nothing was delivered or removed.
    takeNoteDeliveries({ store: { take: () => store.peek() }, stale: [], resumable: new Set(['c1']), now: () => NOW });
    const second = await boot(store, [true]);
    expect(second.delivered).toEqual(['c1']);
    const third = await boot(store, [true]);
    expect(third.delivered).toEqual([]);
  });

  it('a crash after a successful delivery but before the removal delivers it once more (at-least-once)', async () => {
    const { store } = tmpStore();
    store.put('c1', 'carry on with the migration');
    const first = await boot(store, [true], { crashBeforeRemoval: true });
    expect(first.delivered).toEqual(['c1']);
    const second = await boot(store, [true]);
    expect(second.delivered).toEqual(['c1']);
    const third = await boot(store, [true]);
    expect(third.delivered).toEqual([]);
  });

  it('a note delivered early is already gone when a later note is still failing', async () => {
    const { store } = tmpStore();
    store.put('c1', 'first');
    store.put('c2', 'second');
    const c = clock();
    let taken = [];
    const { deliveries } = takeNoteDeliveries({
      store: { take: () => { taken = store.peek(); return taken; } }, stale: [], resumable: new Set(['c1', 'c2']), now: () => NOW,
    });
    const delivery = createNoteDelivery({
      deliver: async (n) => n.convoId === 'c1',
      recover: () => true, discard: (e) => store.discard(e), schedule: c.schedule, cancelTimer: c.cancelTimer, now: c.now,
    });
    delivery.start(deliveries, taken);
    await c.advance(NOTE_FIRST_DELAY_MS);
    expect(store.peek().map(n => n.convoId)).toEqual(['c2']);
  });

  it('a note written for the next restart while retrying survives the removal', async () => {
    const { store } = tmpStore();
    store.put('c1', 'old');
    const c = clock();
    let taken = [];
    const { deliveries } = takeNoteDeliveries({
      store: { take: () => { taken = store.peek(); return taken; } }, stale: [], resumable: new Set(['c1', 'c2']), now: () => NOW,
    });
    const delivery = createNoteDelivery({ deliver: async () => true, discard: (e) => store.discard(e), schedule: c.schedule, cancelTimer: c.cancelTimer, now: c.now });
    delivery.start(deliveries, taken);
    store.put('c2', 'for the next restart');
    await c.advance(NOTE_FIRST_DELAY_MS);
    expect(store.peek().map(n => n.convoId)).toEqual(['c2']);
  });

  it('notes the choice step dropped are removed with the first delivery step', async () => {
    const { store } = tmpStore();
    store.put('not-resumable', 'x');
    store.put('c1', 'y');
    const c = clock();
    let taken = [];
    const { deliveries } = takeNoteDeliveries({
      store: { take: () => { taken = store.peek(); return taken; } }, stale: [], resumable: new Set(['c1']), now: () => NOW,
    });
    createNoteDelivery({ deliver: async () => true, discard: (e) => store.discard(e), schedule: c.schedule, cancelTimer: c.cancelTimer, now: c.now }).start(deliveries, taken);
    expect(store.peek().map(n => n.convoId)).toEqual(['c1']);
  });
});

describe('resume note delivery wiring', () => {
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  it('reads the notes with peek and removes them only through the delivery', () => {
    expect(index).toMatch(/store: \{ take: \(\) => \{ taken = restartNotes\.peek\(\)/);
    expect(index).toMatch(/discard: \(entries\) => restartNotes\.discard\(entries\)/);
    expect(index).not.toMatch(/restartNotes\.take\(/);
  });
  it('delivers through a function that reports failure, with the carry-on cause', () => {
    const fn = index.slice(index.indexOf('async function deliverRestartNote'), index.indexOf('function publishNoteRecoveryCard'));
    expect(fn).toMatch(/journalRouteTextToSession\(target,/);
    expect(fn).toMatch(/causes: \[carryOnCause\(\)\]/);
    expect(fn).toMatch(/return false;/);
  });
  it('refuses to deliver while shutting down, and the delivery is told the bridge is going down', () => {
    const fn = index.slice(index.indexOf('async function deliverRestartNote'), index.indexOf('function publishNoteRecoveryCard'));
    expect(fn).toMatch(/if \(shuttingDown\) return false;/);
    const shutdown = index.slice(index.indexOf('async function gracefulShutdown'));
    expect(index).toMatch(/halted: \(\) => shuttingDown,/);
    expect(shutdown).not.toMatch(/restartNoteDelivery/);
  });
  it('posts the resuming notice on the first attempt only', () => {
    const fn = index.slice(index.indexOf('async function deliverRestartNote'), index.indexOf('function publishNoteRecoveryCard'));
    expect(fn).toMatch(/note\.attempt > 1 \? ''/);
    expect(index).toMatch(/if \(!JOURNAL_ENABLED \|\| !convoId \|\| !body\) return;/);
  });
  it('reports whether the recovery card was published', () => {
    const fn = index.slice(index.indexOf('function publishNoteRecoveryCard'), index.indexOf('function publishNoteRecoveryCard') + 700);
    expect(fn).toMatch(/if \(!JOURNAL_ENABLED\) return false;/);
    expect(fn).toMatch(/return journalPublishCardForConvo\(/);
  });
});
