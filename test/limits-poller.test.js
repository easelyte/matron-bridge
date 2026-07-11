import { describe, it, expect } from 'vitest';
import { createPoller } from '../lib/limits-poller.js';

function harness(overrides = {}) {
  const sent = [];
  const rooms = ['!op:s'];
  const deps = {
    thresholds: [50, 85, 95],
    staleAfter: 3,
    readToken: () => 't',
    recentRooms: () => rooms,
    gateAllows: async () => true,
    send: async (roomId, msg) => {
      sent.push({ roomId, msg });
      return true;
    },
    now: () => 0,
    log: { warn() {}, info() {}, debug() {} },
    fetchUsage: async () => ({ fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 6, resetsAt: null } }),
    ...overrides,
  };
  return { deps, sent, rooms };
}

describe('createPoller.tick', () => {
  it('first tick seeds silently (no alert) even above tier', async () => {
    const { deps, sent } = harness({
      fetchUsage: async () => ({ fiveHour: { utilization: 87, resetsAt: null }, sevenDay: { utilization: 6, resetsAt: null } }),
    });
    const p = createPoller(deps);
    await p.tick();
    expect(sent).toHaveLength(0);
  });

  it('rising edge after seed emits one alert to targeted room', async () => {
    let util = 10;
    const { deps, sent } = harness({
      fetchUsage: async () => ({ fiveHour: { utilization: util, resetsAt: null }, sevenDay: { utilization: 6, resetsAt: null } }),
    });
    const p = createPoller(deps);
    await p.tick();
    util = 90;
    await p.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].msg.plain).toMatch(/5-hour limit at 90%/);
  });

  it('no targeted rooms => tier NOT committed, retried next tick', async () => {
    let util = 10;
    const { deps, sent } = harness({
      recentRooms: () => [],
      fetchUsage: async () => ({ fiveHour: { utilization: util, resetsAt: null }, sevenDay: { utilization: 6, resetsAt: null } }),
    });
    const p = createPoller(deps);
    await p.tick();
    util = 90;
    await p.tick();
    deps.recentRooms = () => ['!op:s'];
    await p.tick();
    expect(sent).toHaveLength(1);
  });

  it('unauthorized room filtered out by gate', async () => {
    let util = 10;
    const { deps, sent } = harness({
      gateAllows: async () => false,
      fetchUsage: async () => ({ fiveHour: { utilization: util, resetsAt: null }, sevenDay: { utilization: 6, resetsAt: null } }),
    });
    const p = createPoller(deps);
    await p.tick();
    util = 90;
    await p.tick();
    expect(sent).toHaveLength(0);
  });

  it('all send failures leave tier uncommitted and retry next tick', async () => {
    let util = 10;
    const attempts = [];
    const { deps } = harness({
      recentRooms: () => ['!a:s', '!b:s'],
      send: async (roomId, msg) => {
        attempts.push({ roomId, msg });
        return false;
      },
      fetchUsage: async () => ({ fiveHour: { utilization: util, resetsAt: null }, sevenDay: { utilization: 6, resetsAt: null } }),
    });
    const p = createPoller(deps);
    await p.tick();
    util = 90;
    await p.tick();
    await p.tick();
    expect(attempts.map((a) => a.roomId)).toEqual(['!a:s', '!b:s', '!a:s', '!b:s']);
  });

  it('send throw is counted as failed send and does not abort tick', async () => {
    let util = 10;
    const attempts = [];
    const { deps } = harness({
      recentRooms: () => ['!bad:s', '!ok:s'],
      send: async (roomId, msg) => {
        attempts.push({ roomId, msg });
        if (roomId === '!bad:s') throw new Error('send exploded');
        return true;
      },
      fetchUsage: async () => ({ fiveHour: { utilization: util, resetsAt: null }, sevenDay: { utilization: 6, resetsAt: null } }),
    });
    const p = createPoller(deps);
    await p.tick();
    util = 90;
    await expect(p.tick()).resolves.toBeUndefined();
    await p.tick();
    expect(attempts.map((a) => a.roomId)).toEqual(['!bad:s', '!ok:s']);
  });
});
