import { describe, it, expect, vi } from 'vitest';
import {
  parseDuration, parseClockTime, formatDuration, parseTimerCommand, createTimerStore,
  timerCancelButton, timerSendNowButton, MIN_TIMER_MS, MAX_TIMER_MS, OVERDUE_GRACE_MS,
} from '../lib/timer-command.js';

// Local-time epoch builder: clock parsing is defined in the HOST's local
// timezone, so every fixture is constructed the same way rather than from a
// UTC literal — these assertions must hold in any TZ the suite runs under.
const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const at = (h, m = 0, s = 0, day = 15) => new Date(2026, 7, day, h, m, s, 0).getTime();

describe('parseDuration', () => {
  it('parses single units', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('parses descending combos', () => {
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1d2h')).toBe(93_600_000);
    expect(parseDuration('1d2h3m4s')).toBe(93_784_000);
  });

  it('is case/whitespace tolerant', () => {
    expect(parseDuration(' 2H ')).toBe(7_200_000);
  });

  it('rejects bare numbers, repeats, ascending order, junk', () => {
    expect(parseDuration('5')).toBeNull();
    expect(parseDuration('2h2h')).toBeNull();
    expect(parseDuration('30m1h')).toBeNull();
    expect(parseDuration('2 h')).toBeNull();
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
});

describe('parseClockTime', () => {
  it('parses 24h H:MM / HH:MM as a delay to that time today', () => {
    expect(parseClockTime('14:30', at(9))).toBe(5 * HOUR + 30 * MINUTE);
    expect(parseClockTime('9:05', at(9))).toBe(5 * MINUTE);
    expect(parseClockTime('00:10', at(0))).toBe(10 * MINUTE);
    expect(parseClockTime('23:59', at(0))).toBe(23 * HOUR + 59 * MINUTE);
  });

  it('parses 12h forms with a meridiem, including hour-only', () => {
    expect(parseClockTime('9:30am', at(9))).toBe(30 * MINUTE);
    expect(parseClockTime('9pm', at(9))).toBe(12 * HOUR);
    expect(parseClockTime('11:45pm', at(9))).toBe(14 * HOUR + 45 * MINUTE);
    expect(parseClockTime('1am', at(0))).toBe(1 * HOUR);
  });

  it('maps 12am to midnight and 12pm to noon', () => {
    expect(parseClockTime('12pm', at(9))).toBe(3 * HOUR);
    expect(parseClockTime('12:10am', at(0))).toBe(10 * MINUTE);
    // 12am today is already past at 00:30 -> tomorrow's midnight.
    expect(parseClockTime('12am', at(0, 30))).toBe(23 * HOUR + 30 * MINUTE);
    expect(parseClockTime('12:30pm', at(0))).toBe(12 * HOUR + 30 * MINUTE);
  });

  it('is case-insensitive and whitespace tolerant', () => {
    expect(parseClockTime(' 9PM ', at(9))).toBe(12 * HOUR);
    expect(parseClockTime('9Am', at(0))).toBe(9 * HOUR);
  });

  it('rolls to tomorrow when the time today has already passed', () => {
    expect(parseClockTime('08:00', at(9))).toBe(23 * HOUR);
    // Exactly now -> tomorrow, never a zero delay.
    expect(parseClockTime('09:00', at(9))).toBe(DAY);
  });

  it('rolls to tomorrow when today is within MIN_TIMER_MS, but keeps the boundary', () => {
    // 3s away — under the minimum, so it means tomorrow, not "instantly".
    expect(parseClockTime('09:00', at(8, 59, 57))).toBe(DAY + 3_000);
    // Exactly MIN_TIMER_MS away — still today.
    expect(parseClockTime('09:00', at(8, 59, 55))).toBe(MIN_TIMER_MS);
  });

  it('rejects out-of-range and non-clock tokens', () => {
    expect(parseClockTime('24:00', at(9))).toBeNull();
    expect(parseClockTime('25:00', at(9))).toBeNull();
    expect(parseClockTime('12:60', at(9))).toBeNull();
    expect(parseClockTime('25:70', at(9))).toBeNull();
    expect(parseClockTime('13pm', at(9))).toBeNull();
    expect(parseClockTime('0pm', at(9))).toBeNull();
    expect(parseClockTime('9:5', at(9))).toBeNull(); // minutes must be 2 digits
    expect(parseClockTime('9', at(9))).toBeNull(); // bare number is a duration's problem
    expect(parseClockTime('12:10 am', at(9))).toBeNull(); // spaced form is unreachable anyway
    expect(parseClockTime('2h', at(9))).toBeNull();
    expect(parseClockTime('soon', at(9))).toBeNull();
    expect(parseClockTime('', at(9))).toBeNull();
    expect(parseClockTime(null, at(9))).toBeNull();
  });

  it('is pure — it reads the injected now, never the real clock', () => {
    const spy = vi.spyOn(Date, 'now');
    try {
      expect(parseClockTime('9pm', at(9))).toBe(12 * HOUR);
      expect(parseClockTime('9pm', at(10))).toBe(11 * HOUR);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('formatDuration', () => {
  it('formats compactly', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(90_061_000)).toBe('1d 1h 1m');
  });

  it('drops sub-minute remainders past a minute and never goes negative', () => {
    expect(formatDuration(61_000)).toBe('1m');
    expect(formatDuration(-5)).toBe('0s');
  });
});

describe('parseTimerCommand', () => {
  it('bare -> list', () => {
    expect(parseTimerCommand('')).toEqual({ kind: 'list' });
    expect(parseTimerCommand('   ')).toEqual({ kind: 'list' });
  });

  it('cancel forms', () => {
    expect(parseTimerCommand('cancel')).toEqual({ kind: 'cancel', which: 'all' });
    expect(parseTimerCommand('cancel all')).toEqual({ kind: 'cancel', which: 'all' });
    expect(parseTimerCommand('cancel 3')).toEqual({ kind: 'cancel', which: 3 });
    expect(parseTimerCommand('cancel #12')).toEqual({ kind: 'cancel', which: 12 });
    expect(parseTimerCommand('cancel nope').kind).toBe('error');
  });

  it('set with plain message keeps original spacing', () => {
    expect(parseTimerCommand("2h hey  what's up")).toEqual({
      kind: 'set', delayMs: 7_200_000, message: "hey  what's up",
    });
  });

  it('set with a slash command as message', () => {
    expect(parseTimerCommand('2h /compact')).toEqual({
      kind: 'set', delayMs: 7_200_000, message: '/compact',
    });
  });

  it('rejects bad duration, too short, too long, empty message', () => {
    expect(parseTimerCommand('soon hello').kind).toBe('error');
    expect(parseTimerCommand('1s hello').kind).toBe('error');
    expect(parseTimerCommand('30d hello').kind).toBe('error');
    expect(parseTimerCommand('2h').kind).toBe('error');
    expect(MIN_TIMER_MS).toBeLessThan(MAX_TIMER_MS);
  });

  it('duration forms parse identically whatever now is injected', () => {
    const spy = vi.spyOn(Date, 'now');
    try {
      for (const now of [at(0), at(9), at(23, 59)]) {
        expect(parseTimerCommand('1h30m ping', now)).toEqual({
          kind: 'set', delayMs: 5_400_000, message: 'ping',
        });
      }
      expect(parseTimerCommand('cancel 3', at(9))).toEqual({ kind: 'cancel', which: 3 });
      expect(parseTimerCommand('', at(9))).toEqual({ kind: 'list' });
      expect(spy).not.toHaveBeenCalled(); // pure when now is supplied
    } finally {
      spy.mockRestore();
    }
  });

  it('sets from a clock time in both 24h and 12h forms', () => {
    expect(parseTimerCommand('00:10 stand up', at(0))).toEqual({
      kind: 'set', delayMs: 10 * MINUTE, message: 'stand up',
    });
    expect(parseTimerCommand('12:10am stand up', at(0))).toEqual({
      kind: 'set', delayMs: 10 * MINUTE, message: 'stand up',
    });
    expect(parseTimerCommand('9pm /compact', at(9))).toEqual({
      kind: 'set', delayMs: 12 * HOUR, message: '/compact',
    });
    expect(parseTimerCommand("14:30 hey  what's up", at(9))).toEqual({
      kind: 'set', delayMs: 5 * HOUR + 30 * MINUTE, message: "hey  what's up",
    });
  });

  it('rolls a past clock time to tomorrow rather than refusing it', () => {
    expect(parseTimerCommand('00:10 morning', at(9))).toEqual({
      kind: 'set', delayMs: 15 * HOUR + 10 * MINUTE, message: 'morning',
    });
    // Under MIN_TIMER_MS today -> tomorrow, so the min guard never trips.
    expect(parseTimerCommand('09:00 morning', at(8, 59, 57))).toEqual({
      kind: 'set', delayMs: DAY + 3_000, message: 'morning',
    });
  });

  it('only reads the first token, so a spaced meridiem lands in the message', () => {
    // Documented non-support: "12:10 am hi" reads the token as the 24h form
    // (12:10 = ten past NOON, not past midnight) and sends "am hi" — which is
    // exactly why the spaced meridiem isn't part of the grammar.
    expect(parseTimerCommand('12:10 am hi', at(0))).toEqual({
      kind: 'set', delayMs: 12 * HOUR + 10 * MINUTE, message: 'am hi',
    });
  });

  it('needs a message for a clock time too', () => {
    expect(parseTimerCommand('00:10', at(0)).kind).toBe('error');
    expect(parseTimerCommand('9pm', at(0)).kind).toBe('error');
  });

  it('errors on clock-shaped but out-of-range tokens, naming the clock forms', () => {
    for (const bad of ['25:70', '24:00', '12:60', '13pm', '0pm', '9:5']) {
      const parsed = parseTimerCommand(`${bad} hi`, at(9));
      expect(parsed.kind).toBe('error');
      expect(parsed.message).toContain(bad);
      expect(parsed.message).toMatch(/clock time/i);
    }
  });

  it('teaches both forms when the token is neither', () => {
    const parsed = parseTimerCommand('soon hello', at(9));
    expect(parsed.kind).toBe('error');
    expect(parsed.message).toMatch(/duration/i);
    expect(parsed.message).toMatch(/clock time/i);
    // Bare numbers stay ambiguous-and-refused, not read as an hour.
    expect(parseTimerCommand('5 hello', at(9)).kind).toBe('error');
  });
});

describe('timerCancelButton', () => {
  it('emits the picker-convention shape the router and dispatcher key on', () => {
    // id prefix `timer-` -> non-answerable frame (journal-input-router
    // PICKER_OPTION_ID); value -> what a Matron tap sends back as the
    // prompt_reply choice (picker-dispatch TIMER_ARG).
    expect(timerCancelButton(12)).toEqual({
      id: 'timer-cancel-12',
      label: '🚫 Cancel timer',
      value: 'timer:cancel:12',
    });
  });
});

describe('timerSendNowButton', () => {
  it('emits the same picker-convention shape with the send verb', () => {
    expect(timerSendNowButton(12)).toEqual({
      id: 'timer-send-12',
      label: '📤 Send now',
      value: 'timer:send:12',
    });
  });
});

// Harness: fake clock + captured timers, no real time or fs.
function makeStore({ persisted, onFire = () => {} } = {}) {
  let clock = 1_000_000;
  const scheduled = new Map(); // handle -> { fn, delay }
  let nextHandle = 1;
  const saves = [];
  const store = createTimerStore({
    load: () => persisted,
    save: (data) => saves.push(JSON.parse(JSON.stringify(data))),
    now: () => clock,
    setTimer: (fn, delay) => {
      const handle = nextHandle++;
      scheduled.set(handle, { fn, delay });
      return handle;
    },
    clearTimer: (handle) => scheduled.delete(handle),
    onFire,
  });
  return {
    store, saves, scheduled,
    tick(ms) {
      clock += ms;
      for (const [handle, t] of [...scheduled]) {
        t.delay -= ms;
        if (t.delay <= 0) {
          scheduled.delete(handle);
          t.fn();
        }
      }
    },
  };
}

describe('createTimerStore', () => {
  it('add persists, arms, and fires exactly once with the record', () => {
    const fired = [];
    const h = makeStore({ onFire: (r) => fired.push(r) });
    const rec = h.store.add({ convoId: 'c1', roomId: 'r1', text: 'hello', delayMs: 60_000 });
    expect(rec.id).toBe(1);
    expect(h.saves.at(-1).timers).toHaveLength(1);

    h.tick(59_999);
    expect(fired).toHaveLength(0);
    h.tick(1);
    expect(fired).toEqual([expect.objectContaining({ id: 1, convoId: 'c1', text: 'hello' })]);
    // Removed + persisted BEFORE onFire ran, so a crash there can't replay.
    expect(h.saves.at(-1).timers).toHaveLength(0);
    expect(h.store.listForConvo('c1')).toHaveLength(0);
  });

  it('removes and persists before invoking onFire, and survives onFire throwing', () => {
    let timersAtFire = null;
    const h = makeStore({
      onFire: () => {
        timersAtFire = h.saves.at(-1).timers.length;
        throw new Error('boom');
      },
    });
    h.store.add({ convoId: 'c1', text: 'x', delayMs: 10_000 });
    expect(() => h.tick(10_000)).not.toThrow();
    expect(timersAtFire).toBe(0);
  });

  it('list is convo-scoped and sorted by fireAt', () => {
    const h = makeStore();
    h.store.add({ convoId: 'c1', text: 'later', delayMs: 120_000 });
    h.store.add({ convoId: 'c2', text: 'other convo', delayMs: 30_000 });
    h.store.add({ convoId: 'c1', text: 'sooner', delayMs: 60_000 });
    expect(h.store.listForConvo('c1').map(t => t.text)).toEqual(['sooner', 'later']);
  });

  it('cancel by id and cancel all are convo-scoped', () => {
    const fired = [];
    const h = makeStore({ onFire: (r) => fired.push(r.text) });
    const a = h.store.add({ convoId: 'c1', text: 'a', delayMs: 60_000 });
    h.store.add({ convoId: 'c1', text: 'b', delayMs: 60_000 });
    h.store.add({ convoId: 'c2', text: 'keep', delayMs: 60_000 });

    expect(h.store.cancel('c2', a.id)).toEqual([]); // wrong convo can't cancel it
    expect(h.store.cancel('c1', a.id).map(t => t.text)).toEqual(['a']);
    expect(h.store.cancel('c1', 'all').map(t => t.text)).toEqual(['b']);
    expect(h.store.cancel('c1', 'all')).toEqual([]);

    h.tick(60_000);
    expect(fired).toEqual(['keep']); // cancelled handles were cleared
  });

  it('fireNow delivers immediately, convo-scoped, removing the record and its handle', () => {
    const fired = [];
    const h = makeStore({ onFire: (r) => fired.push(r.text) });
    const a = h.store.add({ convoId: 'c1', text: 'a', delayMs: 60_000 });
    h.store.add({ convoId: 'c2', text: 'other', delayMs: 60_000 });

    expect(h.store.fireNow('c2', a.id)).toBeNull(); // wrong convo can't fire it
    expect(fired).toEqual([]);

    expect(h.store.fireNow('c1', a.id)).toEqual(expect.objectContaining({ id: a.id, text: 'a' }));
    expect(fired).toEqual(['a']);
    // Removed + persisted (same fire path as natural expiry) — the armed
    // timeout was cleared, so ticking past the original delay can't
    // double-fire, and a repeat tap finds nothing.
    expect(h.saves.at(-1).timers.map(t => t.text)).toEqual(['other']);
    expect(h.store.fireNow('c1', a.id)).toBeNull();
    h.tick(60_000);
    expect(fired).toEqual(['a', 'other']);
  });

  it('ids keep incrementing across cancels (no renumbering races)', () => {
    const h = makeStore();
    const a = h.store.add({ convoId: 'c1', text: 'a', delayMs: 60_000 });
    h.store.cancel('c1', a.id);
    const b = h.store.add({ convoId: 'c1', text: 'b', delayMs: 60_000 });
    expect(b.id).toBe(a.id + 1);
  });

  it('init re-arms persisted timers with remaining delay and graces ONLY overdue ones', () => {
    const fired = [];
    const persisted = {
      nextId: 7,
      timers: [
        { id: 3, convoId: 'c1', roomId: 'r1', fireAt: 1_000_000 + 30_000, text: 'future', createdAt: 0 },
        // Due sooner than the grace window — must still fire at its stored
        // fireAt, NOT be pushed out to the grace (Bugbot, PR #171).
        { id: 4, convoId: 'c1', roomId: 'r1', fireAt: 1_000_000 + 2_000, text: 'near-due', createdAt: 0 },
        { id: 5, convoId: 'c1', roomId: 'r1', fireAt: 1_000_000 - 999_999, text: 'overdue', createdAt: 0 },
      ],
    };
    const h = makeStore({ persisted, onFire: (r) => fired.push(r.text) });
    expect(h.store.init()).toBe(3);

    h.tick(2_000);
    expect(fired).toEqual(['near-due']);
    h.tick(OVERDUE_GRACE_MS - 2_000);
    expect(fired).toEqual(['near-due', 'overdue']);
    h.tick(30_000 - OVERDUE_GRACE_MS);
    expect(fired).toEqual(['near-due', 'overdue', 'future']);

    // nextId carried over — new ids don't collide with persisted ones.
    expect(h.store.add({ convoId: 'c1', text: 'new', delayMs: 60_000 }).id).toBe(7);
  });

  it('tolerates a corrupt/empty persisted file and malformed records', () => {
    const bad = { nextId: 'x', timers: [null, { id: 1 }, { id: 2, convoId: 'c1', fireAt: 1_500_000, text: 'ok' }] };
    const h = makeStore({ persisted: bad });
    expect(h.store.init()).toBe(1);
    expect(h.store.listForConvo('c1')).toHaveLength(1);

    const throwing = createTimerStore({
      load: () => { throw new Error('corrupt'); },
      save: () => {}, now: () => 0, setTimer: () => 1, clearTimer: () => {}, onFire: () => {},
      log: vi.fn(),
    });
    expect(throwing.init()).toBe(0);
  });
});
