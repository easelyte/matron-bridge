import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createNoteDelivery, NOTE_RETRY_MS, NOTE_FIRST_DELAY_MS, NOTE_MAX_AGE_MS } from '../lib/restart-note-delivery.js';

const T0 = Date.parse('2026-11-17T12:00:00Z');
let dir;
let file;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-delivery-')); file = path.join(dir, 'pending.json'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const onDisk = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
const tick = () => new Promise(resolve => setImmediate(resolve));

// A delivery whose timers the test fires by hand, in order of their due time.
function harness({ answers = {}, ...options } = {}) {
  const world = { now: T0, timers: [], delivered: [], recovered: [], settled: [], log: [] };
  const queues = Object.fromEntries(Object.entries(answers).map(([id, list]) => [id, [...list]]));
  const delivery = createNoteDelivery({
    file, now: () => world.now,
    schedule: (fn, ms) => world.timers.push({ fn, at: world.now + ms }),
    deliver: async (entry) => {
      world.delivered.push({ convoId: entry.convoId, status: onDisk().find(e => e.convoId === entry.convoId)?.status, at: world.now });
      const next = queues[entry.convoId]?.length ? queues[entry.convoId].shift() : true;
      if (next instanceof Error) throw next;
      return next;
    },
    recover: (entry) => world.recovered.push(entry.convoId),
    onSettled: (outcomes) => world.settled.push(outcomes),
    log: (m) => world.log.push(m),
    ...options,
  });
  async function run() {
    for (let guard = 0; guard < 50 && world.timers.length; guard++) {
      world.timers.sort((a, b) => a.at - b.at);
      const t = world.timers.shift();
      world.now = Math.max(world.now, t.at);
      t.fn();
      await tick();
    }
  }
  return { world, delivery, run };
}
const note = (convoId, extra = {}) => ({ convoId, text: `note for ${convoId}`, ageMs: 5 * 60_000, interrupted: false, ...extra });

describe('resume note delivery', () => {
  it('writes the notes before delivering anything, then delivers after the first delay', async () => {
    const { world, delivery, run } = harness();
    delivery.start([note('a')]);
    expect(onDisk()).toMatchObject([{ convoId: 'a', text: 'note for a', status: 'pending', attempts: 0, writtenAt: T0 - 5 * 60_000 }]);
    expect(world.delivered).toEqual([]);
    await run();
    expect(world.delivered).toEqual([{ convoId: 'a', status: 'delivering', at: T0 + NOTE_FIRST_DELAY_MS }]);
    expect(onDisk()).toEqual([]);
    expect(world.settled).toEqual([{ a: { outcome: 'resumed', at: T0 + NOTE_FIRST_DELAY_MS } }]);
  });

  it('marks a note delivering before the hand-over (so a crash there is never answered with a second delivery)', async () => {
    const { world, delivery, run } = harness();
    delivery.start([note('a')]);
    await run();
    expect(world.delivered[0].status).toBe('delivering');
  });

  it('a deferred delivery is tried again after a minute and costs no attempt', async () => {
    const { world, delivery, run } = harness({ answers: { a: [{ deferred: true }, { deferred: true }, { deferred: true }, { deferred: true }, true] } });
    delivery.start([note('a')]);
    await run();
    expect(world.delivered.map(d => d.at)).toEqual([0, 1, 2, 3, 4].map(i => T0 + NOTE_FIRST_DELAY_MS + i * NOTE_RETRY_MS));
    expect(world.recovered).toEqual([]);
    expect(world.settled[0].a.outcome).toBe('resumed');
  });

  it('a failed delivery is retried after a minute, three times in all, then the chat gets its card', async () => {
    const { world, delivery, run } = harness({ answers: { a: [false, new Error('no session'), false] } });
    delivery.start([note('a')]);
    await run();
    expect(world.delivered.map(d => d.at)).toEqual([0, 1, 2].map(i => T0 + NOTE_FIRST_DELAY_MS + i * NOTE_RETRY_MS));
    expect(world.recovered).toEqual(['a']);
    expect(onDisk()).toEqual([]);
    expect(world.settled).toEqual([{ a: { outcome: 'failed', at: T0 + NOTE_FIRST_DELAY_MS + 2 * NOTE_RETRY_MS } }]);
  });

  it('a recovery card that throws does not stop the other notes or the settle', async () => {
    const { world, delivery, run } = harness({ answers: { a: [false, false, false] }, recover: () => { throw new Error('journal down'); } });
    delivery.start([note('a'), note('b')]);
    await run();
    expect(world.settled).toHaveLength(1);
    expect(world.settled[0]).toMatchObject({ a: { outcome: 'failed' }, b: { outcome: 'resumed' } });
    expect(world.log.join('\n')).toMatch(/recovery card failed for a/);
  });

  it('a note a crash left delivering is possibly delivered, never delivered again', async () => {
    fs.writeFileSync(file, JSON.stringify([{ id: 'old', convoId: 'a', text: 't', writtenAt: T0 - 1000, status: 'delivering', attempts: 1 }]));
    const { world, delivery, run } = harness();
    delivery.resume();
    await run();
    expect(world.delivered).toEqual([]);
    expect(world.settled).toEqual([{ a: { outcome: 'possibly_delivered', at: T0 } }]);
    expect(onDisk()).toEqual([]);
  });

  it('after a crash, pending notes carry on with their attempts and wait out their backoff', async () => {
    fs.writeFileSync(file, JSON.stringify([{ convoId: 'a', text: 't', writtenAt: T0 - 1000, status: 'pending', attempts: 2, retry_at: T0 + 40_000 }]));
    const { world, delivery, run } = harness({ answers: { a: [false] } });
    delivery.resume();
    await run();
    expect(world.delivered.map(d => d.at)).toEqual([T0 + 40_000]);
    expect(world.recovered).toEqual(['a']);
  });

  it('drops a note older than a day, without a card', async () => {
    const { world, delivery, run } = harness();
    delivery.start([note('a', { ageMs: NOTE_MAX_AGE_MS + 1 })]);
    await run();
    expect(world.delivered).toEqual([]);
    expect(world.recovered).toEqual([]);
    expect(world.settled[0].a.outcome).toBe('stale');
  });

  it('delivers the notes of many chats staggered, two at a time past ten', async () => {
    const { world, delivery, run } = harness();
    delivery.start(Array.from({ length: 12 }, (_, i) => note(`c${i}`)));
    await run();
    const times = world.delivered.map(d => d.at - T0);
    expect(times.slice(0, 4)).toEqual([15000, 15000, 25000, 25000]);
    expect(world.delivered).toHaveLength(12);
  });

  it('one note per conversation: a newer note replaces a pending one', async () => {
    const { delivery } = harness();
    fs.writeFileSync(file, JSON.stringify([{ convoId: 'a', text: 'old', writtenAt: T0 - 9999, status: 'pending', attempts: 1 }]));
    delivery.start([note('a', { text: 'new', ageMs: 10 })]);
    expect(onDisk()).toMatchObject([{ convoId: 'a', text: 'new', attempts: 0 }]);
  });

  it('settles at once when there is nothing to deliver, and only once', () => {
    const { world, delivery } = harness();
    delivery.resume();
    delivery.resume();
    expect(world.settled).toEqual([{}]);
  });

  it('reads the earlier version\'s pending file (restart id on each note)', async () => {
    fs.writeFileSync(file, JSON.stringify([{ id: 'restart-1', convoId: 'a', text: 'carry on with X', writtenAt: T0 - 60_000 }]));
    const { world, delivery, run } = harness();
    delivery.resume();
    await run();
    expect(world.delivered).toHaveLength(1);
    expect(world.settled[0].a.outcome).toBe('resumed');
  });

  it('moves a corrupt pending file aside, keeps going, and drops invalid entries with a log line', () => {
    fs.writeFileSync(file, '{not json');
    const a = harness();
    a.delivery.resume();
    expect(a.world.settled).toEqual([{}]);
    expect(fs.readdirSync(dir).some(n => n.startsWith('pending.json.corrupt-'))).toBe(true);
    fs.writeFileSync(file, JSON.stringify([{ convoId: 'a', text: '', writtenAt: 1 }, { convoId: 'b', text: 'ok', writtenAt: T0 }]));
    const b = harness();
    expect(b.delivery.pendingCount()).toBe(1);
    expect(b.world.log.join('\n')).toMatch(/dropped 1 invalid/);
  });

  it('throws when the notes cannot be made durable, so the caller can hand out cards', () => {
    const { delivery } = harness({ file: path.join(dir, 'missing', 'pending.json') });
    expect(() => delivery.start([note('a')])).toThrow();
  });
});
