// Crash restarts: make a burst visible, and say what the restart cost.
//
// When a session's agent process dies on its own (a signal from outside the
// bridge, an internal crash) the bridge respawns it and posts a one-line
// notice. That is enough for one session. It is not enough when several die
// at once: the shared cause is invisible, and every respawned session comes
// back idle with its background tasks, monitors and subagents gone and
// nothing telling the user or the agent. Two pieces fix that:
//
//   - createCrashWatch counts crash restarts inside a sliding window and
//     says when the count makes it a burst;
//   - recoveryPrompt / crashNoticeText describe the loss, so the respawned
//     agent re-checks its in-flight work and reports instead of sitting idle.
//
// Pure: the clock is injected.

export const CRASH_BURST_WINDOW_MS = 60_000;
export const CRASH_BURST_THRESHOLD = 3;

export function createCrashWatch({
  now = Date.now,
  windowMs = CRASH_BURST_WINDOW_MS,
  threshold = CRASH_BURST_THRESHOLD,
} = {}) {
  let events = [];
  let burstOpen = false;

  function prune(t) {
    events = events.filter(e => t - e.at <= windowMs);
    if (events.length < threshold) burstOpen = false;
  }

  return {
    // Record one crash restart. `burst` is true on the crash that first
    // crosses the threshold; `count` is how many are inside the window.
    note({ convoId, exitCode, signal = null, wasBusy = false, hadWork = false }) {
      const t = now();
      prune(t);
      events.push({ at: t, convoId, exitCode, signal, wasBusy, hadWork });
      const count = events.length;
      const burst = count >= threshold && !burstOpen;
      if (burst) burstOpen = true;
      return { count, burst, inBurst: count >= threshold, events: events.slice() };
    },
    size() {
      prune(now());
      return events.length;
    },
  };
}

// Whether the dead process was holding work that died with it: mid-turn, or
// background tasks seen on the bridge's last periodic observation. No
// observation (a young session) counts as none: the recovery prompt is a
// whole agent turn, and an idle session should not get one on a guess.
export function lostWorkLikely({ busy, bgWorkObserved }) {
  if (busy) return true;
  return bgWorkObserved?.hasWork === true;
}

export function describeExit({ exitCode, signal }) {
  if (signal) return `signal ${signal}`;
  if (exitCode === 143) return 'exit 143 (SIGTERM)';
  if (exitCode === 137) return 'exit 137 (SIGKILL)';
  return `exit ${exitCode}`;
}

// What the respawned agent is told. It runs as the agent's next turn.
export function recoveryPrompt({ exitCode, signal, wasBusy }) {
  const what = describeExit({ exitCode, signal });
  return [
    `Your previous process was stopped from outside this conversation (${what}) and restarted automatically.`,
    wasBusy ? 'A turn was in progress when it died.' : 'You may have been waiting on background work when it died.',
    'Everything that process owned is gone: background shell tasks, monitors, subagents and workers you started.',
    'Do not assume any of it finished. Check what you had in flight (task output files, git status, logs, tracker items),',
    'then either resume it or tell the user plainly which work was lost. If nothing was in flight, reply with one line saying so.',
  ].join(' ');
}

export function crashNoticeText({ exitCode, signal, restartCount, max = 3, willResume }) {
  const what = describeExit({ exitCode, signal });
  const tail = willResume
    ? 'Background work it owned is gone; the agent has been asked to check and resume it or report what was lost.'
    : 'No in-flight work was recorded.';
  return `Session crashed (${what}), restarted automatically — attempt ${restartCount}/${max}. ${tail}`;
}

// The coordinator-facing line for a burst.
export function burstNoticeText({ count, windowMs = CRASH_BURST_WINDOW_MS, exitCodes }) {
  const codes = [...new Set(exitCodes)].join(', ');
  return `${count} sessions crashed within ${Math.round(windowMs / 1000)}s (exit ${codes}). `
    + 'That points to a shared external cause, not individual crashes. '
    + 'Each was restarted and told to re-check its in-flight work; the bridge log has a process snapshot taken at the time.';
}
