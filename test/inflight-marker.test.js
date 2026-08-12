import { describe, it, expect, vi } from 'vitest';
import { createInflightMarker } from '../lib/inflight-marker.js';

function harness({ initial = {}, bootId = 'boot-2', clock = 1_000_000 } = {}) {
  const state = { data: JSON.parse(JSON.stringify(initial)) };
  let t = clock;
  const save = vi.fn((d) => { state.data = JSON.parse(JSON.stringify(d)); });
  const marker = createInflightMarker({
    load: () => state.data,
    save,
    now: () => t,
    bootId,
    touchDebounceMs: 60_000,
  });
  return { marker, state, save, advance: (ms) => { t += ms; }, at: () => t };
}

describe('noteTurnStart / noteTurnEnd', () => {
  it('records a marker stamped with the current bootId and persists it', () => {
    const { marker, state } = harness();
    marker.noteTurnStart('convo-a', 'room-a');
    expect(state.data['convo-a']).toEqual({
      roomId: 'room-a', bootId: 'boot-2', startedAt: 1_000_000, touchedAt: 1_000_000,
    });
  });

  it('removes the marker at turn end', () => {
    const { marker, state } = harness();
    marker.noteTurnStart('convo-a', 'room-a');
    marker.noteTurnEnd('convo-a');
    expect(state.data['convo-a']).toBeUndefined();
  });

  it('tolerates a turn end for an unknown convo', () => {
    const { marker } = harness();
    expect(() => marker.noteTurnEnd('nope')).not.toThrow();
  });
});

describe('touch', () => {
  it('does not persist again inside the debounce window', () => {
    const { marker, save, advance } = harness();
    marker.noteTurnStart('convo-a', 'room-a');
    const callsAfterStart = save.mock.calls.length;
    advance(30_000);
    marker.touch('convo-a');
    expect(save.mock.calls.length).toBe(callsAfterStart);
  });

  it('persists a fresh touchedAt once the debounce window has passed', () => {
    const { marker, state, advance } = harness();
    marker.noteTurnStart('convo-a', 'room-a');
    advance(61_000);
    marker.touch('convo-a');
    expect(state.data['convo-a'].touchedAt).toBe(1_061_000);
    expect(state.data['convo-a'].startedAt).toBe(1_000_000);
  });

  it('ignores a touch for an unknown convo', () => {
    const { marker, state, advance } = harness();
    advance(61_000);
    marker.touch('ghost');
    expect(state.data.ghost).toBeUndefined();
  });
});

describe('takeStale', () => {
  const prev = (touchedAt) => ({
    roomId: 'room-x', bootId: 'boot-1', startedAt: touchedAt - 5_000, touchedAt,
  });

  it('returns previous-boot markers inside the window, with age', () => {
    const { marker } = harness({ initial: { 'convo-a': prev(940_000) } });
    const stale = marker.takeStale(6 * 3600 * 1000);
    expect(stale).toEqual([{
      convoId: 'convo-a', roomId: 'room-x', startedAt: 935_000, touchedAt: 940_000, ageMs: 60_000,
    }]);
  });

  it('never returns markers from the current boot', () => {
    const { marker } = harness({
      initial: { 'convo-live': { roomId: 'r', bootId: 'boot-2', startedAt: 999_000, touchedAt: 999_000 } },
    });
    expect(marker.takeStale(6 * 3600 * 1000)).toEqual([]);
  });

  it('leaves current-boot markers in place after a sweep', () => {
    const live = { roomId: 'r', bootId: 'boot-2', startedAt: 999_000, touchedAt: 999_000 };
    const { marker, state } = harness({ initial: { 'convo-live': live, 'convo-old': prev(940_000) } });
    marker.takeStale(6 * 3600 * 1000);
    expect(state.data['convo-live']).toEqual(live);
  });

  it('excludes markers older than the window', () => {
    const { marker } = harness({ initial: { 'convo-a': prev(1_000_000 - 7 * 3600 * 1000) } });
    expect(marker.takeStale(6 * 3600 * 1000)).toEqual([]);
  });

  it('includes a marker exactly at the window edge', () => {
    const { marker } = harness({ initial: { 'convo-a': prev(1_000_000 - 6 * 3600 * 1000) } });
    expect(marker.takeStale(6 * 3600 * 1000)).toHaveLength(1);
  });

  it('clears every previous-boot marker, including out-of-window ones', () => {
    const { marker, state } = harness({
      initial: { fresh: prev(940_000), ancient: prev(1_000_000 - 7 * 3600 * 1000) },
    });
    marker.takeStale(6 * 3600 * 1000);
    expect(state.data.fresh).toBeUndefined();
    expect(state.data.ancient).toBeUndefined();
  });

  it('is fire-once — a second sweep returns nothing', () => {
    const { marker } = harness({ initial: { 'convo-a': prev(940_000) } });
    expect(marker.takeStale(6 * 3600 * 1000)).toHaveLength(1);
    expect(marker.takeStale(6 * 3600 * 1000)).toEqual([]);
  });

  it('drops malformed records without throwing', () => {
    const { marker } = harness({
      initial: { a: null, b: 'nonsense', c: { bootId: 'boot-1' }, d: { bootId: 'boot-1', touchedAt: 'soon' } },
    });
    expect(marker.takeStale(6 * 3600 * 1000)).toEqual([]);
  });
});

// A clear that never reaches disk leaves the markers there for the next boot to
// find. Reporting them anyway would card the same interruption on every
// subsequent boot, and a persistent disk fault never resolves itself — so the
// repeat is unbounded. takeStale fails closed instead.
describe('takeStale when the clear cannot be written', () => {
  const priorBoot = () => ({
    'convo-1': { roomId: 'room-1', bootId: 'boot-1', startedAt: 999_000, touchedAt: 999_000 },
  });

  it('reports nothing rather than cards it cannot clear', () => {
    const { marker, state, save } = harness({ initial: priorBoot() });
    save.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(marker.takeStale(60_000)).toEqual([]);
    expect(state.data).toEqual(priorBoot());  // disk untouched by the failed write
  });

  it('restores the pre-clear state, so a later successful write does not erase the interruption', () => {
    const { marker, state, save } = harness({ initial: priorBoot() });
    save.mockImplementationOnce(() => { throw new Error('disk full'); });
    marker.takeStale(60_000);

    // Any turn boundary persists. Without the restore this would write the
    // cleared set, dropping an interruption no card was ever published for.
    marker.noteTurnStart('convo-2', 'room-2');

    expect(state.data['convo-1']).toEqual(priorBoot()['convo-1']);
    expect(state.data['convo-2'].bootId).toBe('boot-2');
  });

  it('offers the deferred interruption on the next boot', () => {
    const first = harness({ initial: priorBoot() });
    first.save.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(first.marker.takeStale(60_000)).toEqual([]);  // withheld, not published

    const second = harness({ initial: first.state.data, bootId: 'boot-3' });
    expect(second.marker.takeStale(60_000)).toEqual([
      { convoId: 'convo-1', roomId: 'room-1', startedAt: 999_000, touchedAt: 999_000, ageMs: 1_000 },
    ]);
    expect(second.state.data).toEqual({});  // this boot's clear did land
  });

  it('logs why the cards were withheld', () => {
    const log = vi.fn();
    const marker = createInflightMarker({
      load: () => priorBoot(),
      save: () => { throw new Error('disk full'); },
      now: () => 1_000_000, bootId: 'boot-2', log,
    });
    expect(marker.takeStale(60_000)).toEqual([]);
    expect(log.mock.calls.flat().join(' ')).toMatch(/deferring carry-on cards/);
  });
});

describe('load tolerance', () => {
  it('treats a throwing load as empty and logs', () => {
    const log = vi.fn();
    const marker = createInflightMarker({
      load: () => { throw new Error('corrupt'); },
      save: vi.fn(), now: () => 1, bootId: 'boot-2', log,
    });
    expect(marker.takeStale(1000)).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it('treats a non-object load as empty', () => {
    const marker = createInflightMarker({
      load: () => 'garbage', save: vi.fn(), now: () => 1, bootId: 'boot-2',
    });
    expect(marker.takeStale(1000)).toEqual([]);
  });

  it('never propagates a save failure', () => {
    const log = vi.fn();
    const marker = createInflightMarker({
      load: () => ({}), save: () => { throw new Error('disk full'); },
      now: () => 1, bootId: 'boot-2', log,
    });
    expect(() => marker.noteTurnStart('c', 'r')).not.toThrow();
    expect(log).toHaveBeenCalled();
  });
});
