import { liveWorkChildren } from './work-hold.js';

export function sessionOccupied(session) {
  return !!(session.busy || session.waitingForAnswer || session.pendingInteractivePrompt || session.pendingUnclassifiedPrompt);
}

// Both recovery markers and restart gates use the same work inventory.
export function currentBootSubagents(records, bootAt) {
  if (!Array.isArray(records) || !Number.isFinite(bootAt) || bootAt < 0
    || records.some(child => !Number.isFinite(child?.addedAt) || child.addedAt < 0)) throw new Error('unavailable');
  return records.filter(child => child.addedAt >= bootAt);
}

export function sessionBackgroundWork(session, table, subagents, mcpSignatures = [], convoId = session.journalConvoId || session.claudeSessionId || null) {
  const exec = session.codex && session.codex.transport !== 'app-server';
  const pid = exec ? session.codex.child?.pid
    : session.proc?.pid ?? session.iv?.pty?.pid ?? session.codex?.child?.pid;
  const children = liveWorkChildren(pid, table, mcpSignatures);
  let unknown = false;
  if (exec) {
    session.codex.workGroups = (session.codex.workGroups || []).filter(group => {
      const leader = table.find(row => row.pid === group.pid);
      if (leader && group.startTime && leader.startTime !== group.startTime) return false;
      const hasSession = value => Number.isInteger(value) || (typeof value === 'string' && value.length > 0);
      if (table.some(row => !Number.isInteger(row.pgid) || !hasSession(row.sid))
        || !Number.isInteger(group.pgid) || !hasSession(group.sid)) {
        unknown = table.length > 0 || !!session.codex.child;
        return unknown;
      }
      const members = table.filter(row => row.pid !== group.pid
        && (row.pgid === group.pgid || row.sid === group.sid));
      if (!group.startTime && members.length) unknown = true;
      const eligible = new Set();
      for (const member of members) {
        if (!member.startTime) { unknown = true; continue; }
        if (group.startTime && Date.parse(member.startTime) < Date.parse(group.startTime)) continue;
        eligible.add(member.pid);
      }
      const grouped = table.map(row => eligible.has(row.pid) && !eligible.has(row.ppid)
        ? { ...row, ppid: group.pid } : row);
      children.push(...liveWorkChildren(group.pid, grouped, mcpSignatures));
      return !!leader || members.length > 0;
    });
    const identities = new Map();
    for (const worker of session._bgWorkChildren || []) {
      const live = table.find(row => row.pid === worker.pid && row.startTime === worker.startTime);
      if (live) {
        identities.set(live.pid, { pid: live.pid, startTime: live.startTime });
        children.push(...liveWorkChildren(live.pid, table, mcpSignatures));
      }
    }
    for (const child of children) {
      const live = table.find(row => row.pid === child.pid);
      if (live?.startTime) identities.set(live.pid, { pid: live.pid, startTime: live.startTime });
    }
    session._bgWorkChildren = [...identities.values()];
    for (const worker of session._bgWorkChildren) {
      if (!children.some(child => child.pid === worker.pid)) children.push(worker);
    }
  }
  return { children: unknown || children.length > 0,
    subagents: !!convoId && subagents.some(child => child.parentConvoId === convoId) };
}

// Two complete observations with no work are required. Unlike the idle
// reaper's workHold, a planned restart never ages out a holder.
function observeQuiet({ sessions = [], readProcessTable, listRunningSubagents, mcpSignatures = [], bootAt, prev, hasQueuedInput = () => false } = {}) {
  const holders = [];
  let probe_error = null;
  let table = [];
  let subagents;
  try {
    const observed = readProcessTable();
    if (observed?.ok !== true || !Array.isArray(observed.table)) throw new Error('unavailable');
    table = observed.table;
  } catch {
    // Fixed probe labels keep process argv, environment and exception text
    // out of the published verdict.
    probe_error = 'process_table';
  }
  try {
    subagents = listRunningSubagents();
    subagents = currentBootSubagents(subagents, bootAt);
  } catch {
    subagents = [];
    probe_error ||= 'subagents';
  }
  for (const session of sessions?.values() || []) {
    if (!session?.alive) continue;
    const convoId = session.journalConvoId || session.claudeSessionId || null;
    const hold = (why) => holders.push({ convoId, why });
    if (sessionOccupied(session)) hold('busy');
    if (probe_error !== 'process_table') {
      const work = sessionBackgroundWork(session, table, subagents, mcpSignatures);
      if (work.children) hold('children');
      if (work.subagents) hold('subagents');
    } else if (convoId && subagents.some(child => child.parentConvoId === convoId)) hold('subagents');
    if (hasQueuedInput(session) || session.queuedMessages?.length > 0
      || session._resumeOutbox?.length > 0 || session._awaitingInputReady
      || Object.keys(session._deferredControls || {}).some((kind) => kind !== 'restart_notice')) hold('queued_input');
  }
  const prior = Number.isSafeInteger(prev?.consecutiveQuiet) && prev.consecutiveQuiet >= 0 ? prev.consecutiveQuiet : 0;
  const consecutiveQuiet = probe_error || holders.length ? 0 : prior + 1;
  return { quiet: consecutiveQuiet >= 2, holders, probe_error, consecutiveQuiet };
}

// `readOnly: true` is an observation with no side effect: the inventory
// rewrites a Codex exec session's workGroups and a session's _bgWorkChildren as
// it learns which workers are alive, and those are put back afterwards. Status
// reads and GET /restart use it; only the gate's own evaluation (the one that
// counts quiet readings) leaves the updated inventory in place.
export function evaluateQuiet({ readOnly = false, ...options } = {}) {
  if (!readOnly) return observeQuiet(options);
  const saved = [];
  for (const session of options.sessions?.values?.() || options.sessions || []) {
    if (!session || typeof session !== 'object') continue;
    saved.push([session, session._bgWorkChildren, session.codex && session.codex.workGroups,
      Array.isArray(session._bgWorkChildren) ? [...session._bgWorkChildren] : undefined,
      Array.isArray(session.codex?.workGroups) ? [...session.codex.workGroups] : undefined]);
  }
  try { return observeQuiet(options); } finally {
    for (const [session, bg, groups, bgCopy, groupsCopy] of saved) {
      if (bgCopy !== undefined) session._bgWorkChildren = bgCopy; else if (bg === undefined) delete session._bgWorkChildren;
      if (session.codex) {
        if (groupsCopy !== undefined) session.codex.workGroups = groupsCopy; else if (groups === undefined) delete session.codex.workGroups;
      }
    }
  }
}

// The quiet rule needs two complete observations with no work, and only the
// restart gate (called by the code-update watcher's own tick) may count one.
// Everything else that wants to LOOK at the same inventory (GET /restart, the
// box_status block, the watcher's busy count) goes through peek(), which
// leaves no trace: no reading is counted and no inventory is rewritten. A
// Work observed by a peek() starts the count again. A second gate call within minGapMs of the last counted one (the watcher
// re-runs its decision at once when a request changes under it) reuses that
// reading instead of counting another, so two readings are always at least
// minGapMs apart.
export function createQuietReader(options, { now = Date.now, minGapMs = 5000 } = {}) {
  let prev;
  let last = null;
  let lastAt = -Infinity;
  let generation = 0;
  return {
    // Bumped whenever observed work voids the readings counted so far.
    get generation() { return generation; },
    peek: () => {
      const observed = evaluateQuiet({ ...options(), readOnly: true, prev });
      // Work seen between two gate readings means the readings no longer
      // describe a quiet box: start counting again. This never counts one.
      if (observed.holders.length || observed.probe_error) { prev = undefined; last = null; generation++; }
      return observed;
    },
    count: () => {
      const t = now();
      if (last && t - lastAt >= 0 && t - lastAt < minGapMs) return last;
      const observed = evaluateQuiet({ ...options(), prev });
      prev = observed;
      last = observed;
      lastAt = t;
      return observed;
    },
  };
}

// Inputs being delivered to a session right now (a message, a media download).
// Upstream's work holds only see a turn once it has started, so an input still
// on its way holds a restart until it has landed. begin() returns the matching
// end(), which is safe to call twice.
export function createInputCounter() {
  let n = 0;
  return {
    begin() {
      n++;
      let done = false;
      return () => { if (!done) { done = true; n--; } };
    },
    get count() { return n; },
  };
}
