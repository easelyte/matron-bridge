import { evaluateWindow, usableWindowCount, classifyFailure, formatAlert } from './limits.js';

export function createPoller(deps) {
  const state = {
    fiveHour: { tier: 0, isFirstPoll: true },
    sevenDay: { tier: 0, isFirstPoll: true },
    permFailStreak: 0,
    permReason: null,
    noticeDelivered: false,
  };

  async function targets() {
    const rooms = deps.recentRooms();
    const ok = [];
    for (const r of rooms) if (await deps.gateAllows(r)) ok.push(r);
    return ok;
  }

  async function emitWindow(windowKey, label, usage) {
    const w = usage[windowKey];
    if (w.utilization === null) return;
    const { nextState, crossedTier } = evaluateWindow({ utilization: w.utilization, prev: state[windowKey], thresholds: deps.thresholds });
    if (crossedTier === null) {
      state[windowKey] = nextState;
      return;
    }

    const msg = formatAlert({ window: label, utilization: w.utilization, tier: crossedTier, resetsAt: w.resetsAt, now: deps.now() });
    const rooms = await targets();
    let ok = 0;
    for (const r of rooms) {
      if (await deps.send(r, msg)) ok++;
      else deps.log.warn(`[limits] alert send failed room=${r} tier=${crossedTier}`);
    }
    deps.log.debug(`[limits] window=${label} util=${w.utilization} tier=${nextState.tier} crossed=${crossedTier} targeted=${rooms.length} ok=${ok}`);
    if (ok >= 1) {
      state[windowKey] = nextState;
      deps.log.info(`[limits] ${label} crossed ${crossedTier}% -> alerted ${ok} room(s)`);
    }
  }

  async function handleFailure(e) {
    const f = classifyFailure(e);
    deps.log.debug(`[limits] fetch failure class=${f.class} reason=${f.reason ?? 'none'}: ${e.message}`);
  }

  async function tick() {
    const token = deps.readToken();
    let usage;
    try {
      if (!token) throw Object.assign(new Error('no token'), { status: 401 });
      usage = await deps.fetchUsage({ token });
    } catch (e) {
      return handleFailure(e);
    }
    if (usableWindowCount(usage) === 0) {
      return handleFailure(Object.assign(new Error('zero usable windows'), { malformedBody: true }));
    }

    state.permFailStreak = 0;
    state.permReason = null;
    state.noticeDelivered = false;
    deps.log.debug(`[limits] tick ok 5h=${usage.fiveHour.utilization ?? 'na'}%(t${state.fiveHour.tier}) 7d=${usage.sevenDay.utilization ?? 'na'}%(t${state.sevenDay.tier})`);
    await emitWindow('fiveHour', '5-hour', usage);
    await emitWindow('sevenDay', '7-day', usage);
  }

  return { tick, _state: state };
}
