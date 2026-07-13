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
      let sent;
      try {
        sent = await deps.send(r, msg);
      } catch {
        sent = false;
      }
      if (sent) ok++;
      else deps.log.warn(`[limits] alert send failed room=${r} tier=${crossedTier}`);
    }
    deps.log.debug(`[limits] window=${label} util=${w.utilization} tier=${nextState.tier} crossed=${crossedTier} targeted=${rooms.length} ok=${ok}`);
    if (ok >= 1) {
      state[windowKey] = nextState;
      deps.log.info(`[limits] ${label} crossed ${crossedTier}% -> alerted ${ok} room(s)`);
    }
  }

  const NOTICE = {
    'stale-token': "⚠️ Can't read Claude limits — the OAuth token looks stale or missing. Limit alerts are paused until the next Claude activity refreshes it.",
    malformed: "⚠️ Can't read Claude limits — the usage endpoint returned an unexpected format (it may have changed). Limit alerts are paused until this is fixed in the bridge.",
  };

  async function handleFailure(e) {
    const c = classifyFailure(e);
    if (c.class === 'transient') {
      deps.log.debug(`[limits] transient fetch failure: ${e.message}`);
      return;
    }
    if (state.permReason && state.permReason !== c.reason) {
      state.permFailStreak = 0;
      state.noticeDelivered = false;
    }
    state.permReason = c.reason;
    state.permFailStreak += 1;
    if (state.permFailStreak >= deps.staleAfter && !state.noticeDelivered) {
      const rooms = await targets();
      let ok = 0;
      for (const r of rooms) {
        let sent;
        try {
          sent = await deps.send(r, { plain: NOTICE[c.reason], html: NOTICE[c.reason] });
        } catch {
          sent = false;
        }
        if (sent) ok++;
        else deps.log.warn(`[limits] notice send failed room=${r}`);
      }
      if (ok >= 1) {
        state.noticeDelivered = true;
        deps.log.info(`[limits] permanent-failure notice (${c.reason}) sent to ${ok} room(s)`);
      } else {
        deps.log.warn(`[limits] permanent-failure (${c.reason}) streak=${state.permFailStreak} but NO deliverable room (targeted=${rooms.length}); alerts paused, will retry`);
      }
    }
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
