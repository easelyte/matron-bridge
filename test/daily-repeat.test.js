import { describe, it, expect } from 'vitest';
import {
  nextDailyOccurrence, resolveTimeZone, localTimeZone, normalizeRepeat, formatRepeat,
} from '../lib/daily-repeat.js';

// Every fixture is a UTC literal and every zone is named explicitly, so these
// assertions hold in whatever TZ the suite runs under — the whole point of
// the module is that the box's own zone does not matter.
const utc = (iso) => Date.parse(iso);
const MIN_GAP = 5_000;

// The occurrence after a fire at `iso`, the way the store asks for it.
const after = (hour, minute, tz, iso) => nextDailyOccurrence({ hour, minute, tz }, utc(iso) + MIN_GAP);

describe('nextDailyOccurrence', () => {
  it('returns today when the time is still ahead, tomorrow when it has gone by', () => {
    // 2026-09-30 is BST (UTC+1): 08:00 London = 07:00Z.
    expect(nextDailyOccurrence({ hour: 8, minute: 0, tz: 'Europe/London' }, utc('2026-09-30T05:00:00Z'))).toBe(utc('2026-09-30T07:00:00Z'));
    expect(nextDailyOccurrence({ hour: 8, minute: 0, tz: 'Europe/London' }, utc('2026-09-30T07:00:00Z'))).toBe(utc('2026-09-30T07:00:00Z'));
    expect(nextDailyOccurrence({ hour: 8, minute: 0, tz: 'Europe/London' }, utc('2026-09-30T07:00:00.001Z'))).toBe(utc('2026-10-01T07:00:00Z'));
  });

  it('keys "today" on the zone\'s calendar, not UTC\'s', () => {
    // 23:30Z on the 30th is already 00:30 on 1 October in London: the next
    // 08:00 is that same London day, not 2 October.
    expect(nextDailyOccurrence({ hour: 8, minute: 0, tz: 'Europe/London' }, utc('2026-09-30T23:30:00Z'))).toBe(utc('2026-10-01T07:00:00Z'));
    // Tokyo (UTC+9) is a day ahead of UTC in the evening.
    expect(nextDailyOccurrence({ hour: 9, minute: 0, tz: 'Asia/Tokyo' }, utc('2026-09-30T20:00:00Z'))).toBe(utc('2026-10-01T00:00:00Z'));
  });

  it('Europe/London spring-forward: 08:00 stays 08:00 on the wall clock (GMT then BST)', () => {
    // Clocks go forward at 01:00 GMT on Sunday 29 March 2026.
    expect(after(8, 0, 'Europe/London', '2026-03-28T08:00:00Z')).toBe(utc('2026-03-29T07:00:00Z'));
    expect(after(8, 0, 'Europe/London', '2026-03-29T07:00:00Z')).toBe(utc('2026-03-30T07:00:00Z'));
    // 17:00 likewise: 17:00Z the day before, 16:00Z from the change on.
    expect(after(17, 0, 'Europe/London', '2026-03-28T17:00:00Z')).toBe(utc('2026-03-29T16:00:00Z'));
  });

  it('Europe/London fall-back: 08:00 stays 08:00 on the wall clock (BST then GMT)', () => {
    // Clocks go back at 02:00 BST on Sunday 25 October 2026.
    expect(after(8, 0, 'Europe/London', '2026-10-24T07:00:00Z')).toBe(utc('2026-10-25T08:00:00Z'));
    expect(after(8, 0, 'Europe/London', '2026-10-25T08:00:00Z')).toBe(utc('2026-10-26T08:00:00Z'));
  });

  it('a wall time that does not exist on the spring-forward day resolves to the next valid instant: the moment the clocks jump', () => {
    // 01:30 London never happens on 29 March 2026 (01:00 GMT -> 02:00 BST).
    // It fires at 02:00 BST (01:00Z), the first instant after the gap, and
    // is back to 01:30 the next day.
    expect(after(1, 30, 'Europe/London', '2026-03-28T01:30:00Z')).toBe(utc('2026-03-29T01:00:00Z'));
    expect(after(1, 30, 'Europe/London', '2026-03-29T01:00:00Z')).toBe(utc('2026-03-30T00:30:00Z'));
  });

  it('a wall time that happens twice on the fall-back day fires once, at the first of the two', () => {
    // 01:30 London happens at 00:30Z (BST) and again at 01:30Z (GMT) on 25
    // October 2026. It fires at the first; the second is NOT a second fire.
    expect(after(1, 30, 'Europe/London', '2026-10-24T00:30:00Z')).toBe(utc('2026-10-25T00:30:00Z'));
    expect(after(1, 30, 'Europe/London', '2026-10-25T00:30:00Z')).toBe(utc('2026-10-26T01:30:00Z'));
  });

  it('America/New_York: its own change dates, both directions, and its own gap', () => {
    // US DST 2026: forward Sunday 8 March, back Sunday 1 November.
    expect(after(9, 0, 'America/New_York', '2026-03-07T14:00:00Z')).toBe(utc('2026-03-08T13:00:00Z'));
    expect(after(9, 0, 'America/New_York', '2026-10-31T13:00:00Z')).toBe(utc('2026-11-01T14:00:00Z'));
    // 02:30 does not exist on 8 March in New York: next valid instant is
    // 03:00 EDT = 07:00Z.
    expect(after(2, 30, 'America/New_York', '2026-03-07T07:30:00Z')).toBe(utc('2026-03-08T07:00:00Z'));
    // London is unaffected on the US change date — the zones move apart.
    expect(after(8, 0, 'Europe/London', '2026-03-07T08:00:00Z')).toBe(utc('2026-03-08T08:00:00Z'));
  });

  it('southern hemisphere and half-hour zones', () => {
    // Sydney goes FORWARD on 4 October 2026 (AEST +10 -> AEDT +11).
    expect(after(8, 0, 'Australia/Sydney', '2026-10-01T22:00:00Z')).toBe(utc('2026-10-02T22:00:00Z'));
    expect(after(8, 0, 'Australia/Sydney', '2026-10-02T22:00:00Z')).toBe(utc('2026-10-03T21:00:00Z'));
    // Kolkata (+05:30, no DST).
    expect(nextDailyOccurrence({ hour: 8, minute: 0, tz: 'Asia/Kolkata' }, utc('2026-09-30T00:00:00Z'))).toBe(utc('2026-09-30T02:30:00Z'));
  });
});

describe('resolveTimeZone / localTimeZone', () => {
  it('returns the canonical IANA name, or null for anything that is not one', () => {
    expect(resolveTimeZone('Europe/London')).toBe('Europe/London');
    expect(resolveTimeZone('europe/london')).toBe('Europe/London');
    expect(resolveTimeZone('UTC')).toBe('UTC');
    expect(resolveTimeZone('Mars/Olympus_Mons')).toBeNull();
    expect(resolveTimeZone('')).toBeNull();
    expect(resolveTimeZone(42)).toBeNull();
    // A fixed offset is accepted by Intl but never changes with the seasons,
    // which is the thing `tz` is for.
    expect(resolveTimeZone('+01:00')).toBeNull();
  });

  it('localTimeZone is the zone Intl reports for this process', () => {
    expect(localTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(resolveTimeZone(localTimeZone())).toBe(localTimeZone());
  });
});

describe('normalizeRepeat / formatRepeat', () => {
  it('accepts the persisted shape and rejects anything malformed', () => {
    const ok = { kind: 'daily', hour: 8, minute: 0, tz: 'Europe/London' };
    expect(normalizeRepeat(ok)).toEqual(ok);
    expect(normalizeRepeat(undefined)).toBeNull();
    expect(normalizeRepeat({ ...ok, kind: 'weekly' })).toBeNull();
    expect(normalizeRepeat({ ...ok, hour: 24 })).toBeNull();
    expect(normalizeRepeat({ ...ok, minute: 60 })).toBeNull();
    expect(normalizeRepeat({ ...ok, hour: '8' })).toBeNull();
    expect(normalizeRepeat({ ...ok, tz: 'Nowhere/Land' })).toBeNull();
  });

  it('renders "daily at HH:MM Zone"', () => {
    expect(formatRepeat({ kind: 'daily', hour: 8, minute: 0, tz: 'Europe/London' })).toBe('daily at 08:00 Europe/London');
    expect(formatRepeat({ kind: 'daily', hour: 17, minute: 5, tz: 'UTC' })).toBe('daily at 17:05 UTC');
  });
});
