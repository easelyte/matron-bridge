// The one notice each live session gets when a planned restart is pending: the
// restart will wait until nothing is running, so the session should write a
// resume note first (reminder_create restart_note: true). One notice per
// session per restart; repeats go to box_status, never to sessions.
export function restartNoticeText(requests) {
  const reasons = requests.map(request => request.reason).filter(Boolean).join('; ').slice(0, 1000);
  return `The bridge will restart once nothing is running on it (${reasons}). Before ending this turn, write your resume note with \`reminder_create restart_note: true\`: what you are doing, what runs in the background and where, any in-process wait you rely on (ScheduleWakeup, CronCreate, Monitor) since those die with the process, and the next step. Your work will not be cut off; you will be carried on after the restart.`;
}

// `sessions()` yields live sessions; `ready(session)` says whether the session
// can take a turn now (not mid-turn, not waiting on a prompt); `send(session,
// text)` hands it the notice and returns true once delivered; `convoIdOf` names
// the session the way the note and the state file do.
// A send that keeps failing (a session that refuses input) is given up on after
// MAX_ATTEMPTS: the session counts as told, so it cannot hold the restart (or
// repeat a failure message in its chat) for ever; it has no note, so it is
// listed as `no_note` and not resumed.
const MAX_ATTEMPTS = 3;

export function createRestartNotices({ stateStore, sessions, ready, send, convoIdOf, log = () => {} }) {
  const failures = new Map();
  const sent = new Set();
  return {
    // Tell every live session that has not been told. A session that is busy,
    // or whose send fails, is left for the next poll.
    notifyPending() {
      const state = stateStore.getState();
      if (state.state !== 'pending') return [];
      const told = [];
      for (const session of sessions()) {
        const id = convoIdOf(session);
        if (!id || Object.hasOwn(state.notified, id) || !ready(session)) continue;
        const key = JSON.stringify([state.id, id]);
        // Sent, but the state write below failed: do not send it again.
        if (sent.has(key)) {
          stateStore.markNotified(state.id, id);
          told.push(id);
          continue;
        }
        if (send(session, restartNoticeText(state.requests)) === true) sent.add(key);
        else {
          const count = (failures.get(key) ?? 0) + 1;
          failures.set(key, count);
          if (count < MAX_ATTEMPTS) continue;
          log('Planned restart notice could not be delivered; the session will not be waited for');
        }
        stateStore.markNotified(state.id, id);
        told.push(id);
      }
      return told;
    },
  };
}
