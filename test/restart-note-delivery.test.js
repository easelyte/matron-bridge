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
function harness({ answers = {}, settleAnswers = [true], ...options } = {}) {
  const world = { now: T0, timers: [], delivered: [], recovered: [], settled: [], owners: [], log: [] };
  const queues = Object.fromEntries(Object.entries(answers).map(([id, list]) => [id, [...list]]));
  const settleQueue = [...settleAnswers];
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
    onSettled: (outcomes, owner) => { world.settled.push(outcomes); world.owners.push(owner); return settleQueue.length > 1 ? settleQueue.shift() : settleQueue[0]; },
    log: (m) => world.log.push(m),
    ...options,
  });
  async function run() {
    for (let guard = 0; guard < 60 && world.timers.length; guard++) {
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
    expect(world.settled).toEqual([{ a: { outcome: 'resumed', at: T0 + NOTE_FIRST_DELAY_MS } }]);
    expect(onDisk()).toEqual([]);
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
    delivery.intakeComplete();
    delivery.resume();
    await run();
    expect(world.delivered).toEqual([]);
    expect(world.settled).toEqual([{ a: { outcome: 'possibly_delivered', at: T0 } }]);
  });

  it('after a crash, pending notes carry on with their attempts and wait out their backoff', async () => {
    fs.writeFileSync(file, JSON.stringify([{ convoId: 'a', text: 't', writtenAt: T0 - 1000, status: 'pending', attempts: 2, retry_at: T0 + 40_000 }]));
    const { world, delivery, run } = harness({ answers: { a: [false] } });
    delivery.intakeComplete();
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
    expect(world.delivered.slice(0, 4).map(d => d.at - T0)).toEqual([15000, 15000, 25000, 25000]);
    expect(world.delivered).toHaveLength(12);
  });

  it('one note per conversation: a newer note replaces a pending one', () => {
    const { delivery } = harness();
    fs.writeFileSync(file, JSON.stringify([{ convoId: 'a', text: 'old', writtenAt: T0 - 9999, status: 'pending', attempts: 1 }]));
    delivery.start([note('a', { text: 'new', ageMs: 10 })]);
    expect(onDisk()).toMatchObject([{ convoId: 'a', text: 'new', attempts: 0 }]);
  });

  it('reads the earlier version\'s pending file (restart id on each note)', async () => {
    fs.writeFileSync(file, JSON.stringify([{ id: 'restart-1', convoId: 'a', text: 'carry on with X', writtenAt: T0 - 60_000 }]));
    const { world, delivery, run } = harness();
    delivery.intakeComplete();
    delivery.resume();
    await run();
    expect(world.delivered).toHaveLength(1);
    expect(world.settled[0].a.outcome).toBe('resumed');
  });

  it('moves a corrupt pending file aside, keeps going, and drops invalid entries with a log line', () => {
    fs.writeFileSync(file, '{not json');
    const a = harness();
    a.delivery.intakeComplete();
    a.delivery.resume();
    expect(a.world.settled).toEqual([{}]);
    expect(fs.readdirSync(dir).some(n => n.startsWith('pending.json.corrupt-'))).toBe(true);
    fs.writeFileSync(file, JSON.stringify([{ convoId: 'a', text: '', writtenAt: 1 }, { convoId: 'b', text: 'ok', writtenAt: T0 }]));
    const b = harness();
    expect(b.delivery.pendingCount()).toBe(1);
    expect(b.world.log.join('\n')).toMatch(/dropped 1 invalid/);
  });

  it('throws when the notes cannot be made durable, before anything was delivered', () => {
    const { world, delivery } = harness({ file: path.join(dir, 'missing', 'pending.json') });
    expect(() => delivery.start([note('a')])).toThrow();
    expect(world.delivered).toEqual([]);
  });
});

describe('review follow-ups: nothing lost, nothing settled early', () => {
  it('does not settle until the boot code says intake is complete, even with an empty queue', () => {
    const { world, delivery } = harness();
    delivery.resume();
    expect(world.settled).toEqual([]);
    delivery.intakeComplete();
    expect(world.settled).toEqual([{}]);
  });

  it('a note taken twice (written here, then the source survived a crash) is delivered once', async () => {
    const a = harness();
    const taken = { ...note('a'), writtenAt: T0 - 120_000 };
    a.delivery.start([taken]);
    await a.run();
    expect(a.world.delivered).toHaveLength(1);
    // The process died before the restart record was closed: entries are still on disk.
    fs.writeFileSync(file, JSON.stringify([{ convoId: 'a', text: 'note for a', writtenAt: T0 - 120_000, status: 'done', outcome: 'resumed', outcome_at: T0 }]));
    const b = harness();
    b.delivery.start([taken]);
    await b.run();
    expect(b.world.delivered).toEqual([]);
    expect(b.world.settled).toEqual([{ a: { outcome: 'resumed', at: T0 } }]);
  });

  it('outcomes survive a crash before the record is closed: a failure is not forgotten', async () => {
    const a = harness({ answers: { a: [false, false, false] }, settleAnswers: [false] });
    a.delivery.start([note('a'), note('b')]);
    await a.run();
    // Closing the record failed every time: everything is still on disk.
    expect(onDisk().map(e => [e.convoId, e.status, e.outcome])).toEqual(expect.arrayContaining([['a', 'done', 'failed'], ['b', 'done', 'resumed']]));
    const b = harness();
    b.delivery.intakeComplete();
    b.delivery.resume();
    expect(b.world.settled[0]).toMatchObject({ a: { outcome: 'failed' }, b: { outcome: 'resumed' } });
    expect(onDisk()).toEqual([]);
  });

  it('a record that could not be closed is tried again after a minute, with the same outcomes', async () => {
    const { world, delivery, run } = harness({ settleAnswers: [false, false, true] });
    delivery.start([note('a')]);
    await run();
    expect(world.settled).toHaveLength(3);
    expect(world.settled[2]).toEqual(world.settled[0]);
    expect(onDisk()).toEqual([]);
  });

  it('a recovery card that was due when the process died is published at the next boot', () => {
    fs.writeFileSync(file, JSON.stringify([{ convoId: 'a', text: 't', writtenAt: T0 - 1000, status: 'done', outcome: 'failed', outcome_at: T0, card: 'due', attempts: 3 }]));
    const { world, delivery } = harness();
    delivery.intakeComplete();
    delivery.resume();
    expect(world.recovered).toEqual(['a']);
    expect(world.settled[0].a.outcome).toBe('failed');
  });

  it('a note started after an earlier settle is reported too', async () => {
    const { world, delivery, run } = harness();
    delivery.resume();
    delivery.intakeComplete();
    expect(world.settled).toHaveLength(1);
    delivery.start([note('a')]);
    await run();
    expect(world.settled).toHaveLength(2);
    expect(world.settled[1].a.outcome).toBe('resumed');
  });
});

describe('review follow-ups, round two', () => {
  it('a newer note for a chat does not erase an outcome that was never acknowledged', async () => {
    fs.writeFileSync(file, JSON.stringify([{ convoId: 'a', text: 'old', writtenAt: T0 - 9000, status: 'done', outcome: 'failed', outcome_at: T0 - 100, card: 'done', attempts: 3, owner: 'R1' }]));
    const { world, delivery, run } = harness({ owner: () => 'R2' });
    delivery.start([note('a', { text: 'new', ageMs: 10 })]);
    await run();
    // One report per record: R1 keeps its failure, R2 its resumed note.
    expect(world.owners.sort()).toEqual(['R1', 'R2']);
    const byOwner = Object.fromEntries(world.settled.map((outcomes, i) => [world.owners[i], outcomes]));
    expect(byOwner.R1.a.outcome).toBe('failed');
    expect(byOwner.R2.a.outcome).toBe('resumed');
  });

  it('notes that could not be queued are reported failed with everything else, in one report', async () => {
    fs.writeFileSync(file, JSON.stringify([{ convoId: 'a', text: 't', writtenAt: T0 - 1000, status: 'pending', attempts: 0 }]));
    const { world, delivery, run } = harness();
    delivery.failIntake([note('c')]);
    delivery.intakeComplete();
    delivery.resume();
    expect(world.settled).toEqual([]);
    await run();
    expect(world.settled).toHaveLength(1);
    expect(world.settled[0]).toMatchObject({ a: { outcome: 'resumed' }, c: { outcome: 'failed' } });
  });

  it('a start that cannot begin delivery does not throw after the notes were written', () => {
    const { world, delivery } = harness({ schedule: () => { throw new Error('no timers'); } });
    expect(() => delivery.start([note('a')])).not.toThrow();
    expect(world.log.join('\n')).toMatch(/could not start delivery/);
    expect(onDisk()).toHaveLength(1);
  });

  it('reports the worst outcome when a chat has more than one in the same report', () => {
    fs.writeFileSync(file, JSON.stringify([
      { convoId: 'a', text: 't', writtenAt: T0 - 2000, status: 'done', outcome: 'resumed', outcome_at: 1, owner: 'R' },
      { convoId: 'a', text: 't', writtenAt: T0 - 1000, status: 'done', outcome: 'possibly_delivered', outcome_at: 2, owner: 'R' },
    ]));
    const { world, delivery } = harness();
    delivery.intakeComplete();
    delivery.resume();
    expect(world.settled).toEqual([{ a: { outcome: 'possibly_delivered', at: 2 } }]);
    expect(world.owners).toEqual(['R']);
  });

  it('reports once, even when more timers fire afterwards', async () => {
    const { world, delivery, run } = harness();
    delivery.start([note('a'), note('b')]);
    await run();
    expect(world.settled).toHaveLength(1);
  });
});
