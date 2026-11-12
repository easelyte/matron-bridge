// Crash restarts: make a burst visible, and tell a respawned agent what died.
//
// When a session's agent process dies on its own (a signal from outside the
// bridge, an internal crash) the bridge respawns it and posts a one-line
// notice. That is enough for one session. It is not enough when several die
// at once: the shared cause is invisible, and every session that died
// mid-turn comes back idle with nothing telling the agent. Three pieces:
//
//   - createCrashWatch counts distinct crashed conversations inside a sliding
//     window and says when the count makes it a burst;
//   - appendCrashLog keeps a small, bounded record on disk;
//   - recoveryPrompt / burstNoticeText word the carry-on turn for a session
//     that died mid-turn and the one-line notice for the user.
//
// Pure apart from the log file: the clock is injected.
import fs from 'fs';
import path from 'path';

export const CRASH_BURST_WINDOW_MS = 60_000;
export const CRASH_BURST_THRESHOLD = 3;
// Hard cap on remembered events, whatever the window: a crash loop across many
// sessions must not grow this without bound.
export const CRASH_WATCH_MAX_EVENTS = 100;
export const CRASH_LOG_MAX_ENTRIES = 200;

export function createCrashWatch({
  now = Date.now,
  windowMs = CRASH_BURST_WINDOW_MS,
  threshold = CRASH_BURST_THRESHOLD,
  maxEvents = CRASH_WATCH_MAX_EVENTS,
} = {}) {
  let events = [];
  let burstOpen = false;

  function prune(t) {
    events = events.filter(e => t - e.at <= windowMs);
    if (events.length > maxEvents) events = events.slice(events.length - maxEvents);
    if (new Set(events.map(e => e.convoId)).size < threshold) burstOpen = false;
  }

  return {
    // Record one crash restart. `burst` is true on the crash that first
    // crosses the threshold; `count` is the distinct conversations in the window.
    note({ convoId, exitCode, signal = null, wasBusy = false }) {
      const t = now();
      prune(t);
      events.push({ at: t, convoId, exitCode, signal, wasBusy });
      if (events.length > maxEvents) events = events.slice(events.length - maxEvents);
      const count = new Set(events.map(e => e.convoId)).size;
      if (count < threshold) burstOpen = false;
      const burst = count >= threshold && !burstOpen;
      if (burst) burstOpen = true;
      return { count, burst, events: events.slice() };
    },
    size() {
      prune(now());
      return events.length;
    },
  };
}

// Append one JSON line to `file`, keeping only the newest `maxEntries` lines.
// The file is rewritten through a temp file so a crash mid-write leaves the
// old log intact. Best effort: returns false instead of throwing.
export function appendCrashLog(file, record, { maxEntries = CRASH_LOG_MAX_ENTRIES } = {}) {
  try {
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch { /* first entry, or unreadable: start over */ }
    lines.push(JSON.stringify(record));
    if (lines.length > maxEntries) lines = lines.slice(lines.length - maxEntries);
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// Cap a process-table dump (ps output) for the log: first `maxLines` lines,
// each truncated.
export function truncateSnapshot(text, { maxLines = 40, maxLineLength = 200 } = {}) {
  return String(text ?? '').split('\n').slice(0, maxLines).map(l => l.slice(0, maxLineLength)).join('\n');
}

export function describeExit({ exitCode, signal }) {
  if (signal) return `signal ${signal}`;
  if (exitCode === 143) return 'exit 143 (SIGTERM)';
  if (exitCode === 137) return 'exit 137 (SIGKILL)';
  return `exit ${exitCode}`;
}

// The carry-on text for a session whose previous run died mid-turn. It runs
// as the agent's next turn.
export function recoveryPrompt({ exitCode, signal }) {
  return [
    `Your previous run died mid-turn (${describeExit({ exitCode, signal })}) and was restarted automatically.`,
    'Everything that process owned is gone: background shell tasks, monitors and subagents you started.',
    'Do not assume any of it finished. Check what you had in flight (task output files, git status, logs),',
    'then either resume it or tell the user plainly which work was lost.',
  ].join(' ');
}

// The user-facing line for a burst.
// `exits` are describeExit strings.
export function burstNoticeText({ count, windowMs = CRASH_BURST_WINDOW_MS, exits }) {
  const what = [...new Set(exits)].join(', ');
  return `${count} sessions crashed within ${Math.round(windowMs / 1000)}s (${what}). `
    + 'That points to a shared external cause rather than individual crashes. '
    + 'Each was restarted automatically; the bridge log has a process snapshot taken at the time.';
}
