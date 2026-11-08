import { describe, it, expect } from 'vitest';
import { createLimiter } from '../lib/concurrency.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));

describe('createLimiter', () => {
  it('runs at most max at once and starts the rest in order as slots free up', async () => {
    const limit = createLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started = [];
    const runs = gates.map((g, i) => limit(async () => { started.push(i); await g.promise; return i; }));
    await tick();
    expect(started).toEqual([0, 1]);
    gates[1].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[0].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2].resolve();
    gates[3].resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
  });

  it('a newcomer cannot jump the queue or take the count past max when a slot is handed over', async () => {
    const limit = createLimiter(1);
    const first = deferred();
    const started = [];
    let running = 0;
    let peak = 0;
    const job = (id, gate) => async () => {
      started.push(id);
      running++;
      peak = Math.max(peak, running);
      await gate;
      running--;
    };
    const runs = [limit(job('first', first.promise)), limit(job('waiter', Promise.resolve()))];
    first.resolve();
    await Promise.resolve();
    runs.push(limit(job('newcomer', Promise.resolve())));
    await Promise.all(runs);
    expect(started).toEqual(['first', 'waiter', 'newcomer']);
    expect(peak).toBe(1);
  });

  it('a rejected call rejects its own caller and frees its slot', async () => {
    const limit = createLimiter(1);
    const failing = limit(async () => { throw new Error('nope'); });
    const next = limit(async () => 'ok');
    await expect(failing).rejects.toThrow('nope');
    expect(await next).toBe('ok');
  });
});
