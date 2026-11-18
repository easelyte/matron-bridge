import { describe, it, expect, vi } from 'vitest';
import { createOutcomeNoteDelivery } from '../lib/restart-note-outcomes.js';

// A stand-in for upstream's createNoteDelivery: runs each chosen note once,
// with the retries collapsed (a failing note is carded straight away).
function fakeDelivery() {
  return ({ deliver, recover }) => ({
    start(deliveries) {
      for (const d of deliveries) {
        void (async () => {
          const ok = await deliver({ ...d, attempt: 1 });
          if (ok !== true) recover(d);
        })();
      }
    },
    stop() {},
  });
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function build(overrides = {}) {
  const onSettled = vi.fn(() => true);
  const delivery = createOutcomeNoteDelivery({
    deliver: async (n) => n.convoId !== 'bad',
    recover: () => true,
    owner: () => 'rec-1',
    onSettled,
    createDelivery: fakeDelivery(),
    now: () => 42,
    ...overrides,
  });
  return { delivery, onSettled };
}

describe('createOutcomeNoteDelivery', () => {
  it('reports resumed, failed and stale outcomes once, after intake is complete', async () => {
    const { delivery, onSettled } = build();
    const taken = [{ convoId: 'a', writtenAt: 1 }, { convoId: 'bad', writtenAt: 2 }, { convoId: 'old', writtenAt: 3 }];
    delivery.start([taken[0], taken[1]], taken);
    await flush();
    expect(onSettled).not.toHaveBeenCalled();
    delivery.intakeComplete();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith({
      a: { outcome: 'resumed', at: 42 },
      bad: { outcome: 'failed', at: 42 },
      old: { outcome: 'stale', at: 42 },
    }, 'rec-1');
  });

  it('waits for the last note before reporting', async () => {
    let release;
    const { delivery, onSettled } = build({ deliver: () => new Promise(resolve => { release = () => resolve(true); }) });
    delivery.start([{ convoId: 'a', writtenAt: 1 }], [{ convoId: 'a', writtenAt: 1 }]);
    delivery.intakeComplete();
    expect(onSettled).not.toHaveBeenCalled();
    release();
    await flush();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled.mock.calls[0][0]).toEqual({ a: { outcome: 'resumed', at: 42 } });
  });

  it('closes the record with no outcomes when there were no notes', () => {
    const { delivery, onSettled } = build();
    delivery.intakeComplete();
    expect(onSettled).toHaveBeenCalledWith({}, 'rec-1');
  });

  it('retries a report that was not acknowledged, and gives up after the cap', () => {
    const timers = [];
    const onSettled = vi.fn(() => false);
    const delivery = createOutcomeNoteDelivery({
      deliver: async () => true, owner: () => null, onSettled, createDelivery: fakeDelivery(),
      schedule: (fn) => { timers.push(fn); return { unref() {} }; }, settleMaxTries: 3,
    });
    delivery.intakeComplete();
    expect(onSettled).toHaveBeenCalledTimes(1);
    timers.shift()();
    timers.shift()();
    expect(onSettled).toHaveBeenCalledTimes(3);
    expect(timers).toHaveLength(0);
  });

  it('treats a throwing owner() as no owner', () => {
    const { delivery, onSettled } = build({ owner: () => { throw new Error('x'); } });
    delivery.intakeComplete();
    expect(onSettled).toHaveBeenCalledWith({}, null);
  });
});
