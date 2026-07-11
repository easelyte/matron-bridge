import { describe, it, expect } from 'vitest';
import { createPoller } from '../lib/limits-poller.js';
import { LimitsFetchError } from '../lib/limits.js';

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

describe('createPoller permanent-failure escalation', () => {
  function failHarness(err, staleAfter = 3) {
    const sent = [];
    const deps = {
      thresholds: [50, 85, 95],
      staleAfter,
      readToken: () => 't',
      recentRooms: () => ['!op:s'],
      gateAllows: async () => true,
      send: async (r, m) => {
        sent.push(m);
        return true;
      },
      now: () => 0,
      log: { warn() {}, info() {}, debug() {} },
      fetchUsage: async () => {
        throw err;
      },
    };
    return { deps, sent };
  }

  // "Accumulated" not "consecutive": transient ticks are no-ops for the streak.
  // Only a successful usage fetch resets the permanent-failure episode.
  it('escalates once after staleAfter accumulated permanent (stale-token) failures', async () => {
    const { deps, sent } = failHarness(new LimitsFetchError('x', { status: 401 }), 3);
    const p = createPoller(deps);
    await p.tick();
    await p.tick();
    expect(sent).toHaveLength(0);
    await p.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].plain).toMatch(/stale or missing/);
    await p.tick();
    expect(sent).toHaveLength(1);
  });

  it('malformed uses the malformed notice text', async () => {
    const { deps, sent } = failHarness(new LimitsFetchError('x', { status: 400 }), 1);
    const p = createPoller(deps);
    await p.tick();
    expect(sent[0].plain).toMatch(/unexpected format/);
  });

  it('transient tick between permanent failures does NOT reset the streak', async () => {
    let mode = 'perm';
    const sent = [];
    const deps = {
      thresholds: [50, 85, 95],
      staleAfter: 3,
      readToken: () => 't',
      recentRooms: () => ['!op:s'],
      gateAllows: async () => true,
      send: async (r, m) => {
        sent.push(m);
        return true;
      },
      now: () => 0,
      log: { warn() {}, info() {}, debug() {} },
      fetchUsage: async () => {
        throw new LimitsFetchError('x', { status: mode === 'perm' ? 401 : 503 });
      },
    };
    const p = createPoller(deps);
    await p.tick();
    mode = 'transient';
    await p.tick();
    mode = 'perm';
    await p.tick();
    await p.tick();
    expect(sent).toHaveLength(1);
  });

  it('escalation with no deliverable room: not marked delivered, warns, retries', async () => {
    const warns = [];
    const { deps, sent } = failHarness(new LimitsFetchError('x', { status: 401 }), 3);
    deps.recentRooms = () => [];
    deps.log = { warn: (m) => warns.push(m), info() {}, debug() {} };
    const p = createPoller(deps);
    await p.tick();
    await p.tick();
    await p.tick();
    expect(warns.some((m) => /NO deliverable room/.test(m))).toBe(true);
    expect(sent).toHaveLength(0);
    deps.recentRooms = () => ['!op:s'];
    await p.tick();
    expect(sent).toHaveLength(1);
  });

  it('escalation notice send throws: not marked delivered, warns, retries', async () => {
    const attempts = [];
    const warns = [];
    const { deps } = failHarness(new LimitsFetchError('x', { status: 401 }), 1);
    deps.recentRooms = () => ['!a:s', '!b:s'];
    deps.send = async (roomId) => {
      attempts.push(roomId);
      throw new Error('send exploded');
    };
    deps.log = { warn: (m) => warns.push(m), info() {}, debug() {} };
    const p = createPoller(deps);

    await expect(p.tick()).resolves.toBeUndefined();
    await expect(p.tick()).resolves.toBeUndefined();

    expect(attempts).toEqual(['!a:s', '!b:s', '!a:s', '!b:s']);
    expect(warns.filter((m) => /notice send failed room=/.test(m))).toHaveLength(4);
    expect(warns.filter((m) => /NO deliverable room/.test(m))).toHaveLength(2);
    expect(p._state.noticeDelivered).toBe(false);
  });

  it('escalation with rooms filtered by gate: no notice, not marked delivered, retries', async () => {
    const sent = [];
    const gateChecks = [];
    const warns = [];
    const { deps } = failHarness(new LimitsFetchError('x', { status: 401 }), 1);
    deps.recentRooms = () => ['!a:s', '!b:s'];
    deps.gateAllows = async (roomId) => {
      gateChecks.push(roomId);
      return false;
    };
    deps.send = async (roomId, msg) => {
      sent.push({ roomId, msg });
      return true;
    };
    deps.log = { warn: (m) => warns.push(m), info() {}, debug() {} };
    const p = createPoller(deps);

    await p.tick();
    await p.tick();

    expect(gateChecks).toEqual(['!a:s', '!b:s', '!a:s', '!b:s']);
    expect(sent).toHaveLength(0);
    expect(warns.filter((m) => /NO deliverable room/.test(m))).toHaveLength(2);
    expect(p._state.noticeDelivered).toBe(false);
  });
});
