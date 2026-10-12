import { liveWorkChildren } from './work-hold.js';

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
  if (exec) {
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
  return { children: children.length > 0,
    subagents: !!convoId && subagents.some(child => child.parentConvoId === convoId) };
}

// Two complete observations with no work are required. Unlike the idle
// reaper's workHold, a planned restart never ages out a holder.
export function evaluateQuiet({ sessions = [], readProcessTable, listRunningSubagents, mcpSignatures = [], bootAt, prev } = {}) {
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
    if (session.busy || session.waitingForAnswer || session.pendingInteractivePrompt || session.pendingUnclassifiedPrompt) hold('busy');
    if (probe_error !== 'process_table') {
      const work = sessionBackgroundWork(session, table, subagents, mcpSignatures);
      if (work.children) hold('children');
      if (work.subagents) hold('subagents');
    } else if (convoId && subagents.some(child => child.parentConvoId === convoId)) hold('subagents');
    if (session.queuedMessages?.length > 0
      || Object.keys(session._deferredControls || {}).some((kind) => kind !== 'restart_notice')) hold('queued_input');
  }
  const prior = Number.isSafeInteger(prev?.consecutiveQuiet) && prev.consecutiveQuiet >= 0 ? prev.consecutiveQuiet : 0;
  const consecutiveQuiet = probe_error || holders.length ? 0 : prior + 1;
  return { quiet: consecutiveQuiet >= 2, holders, probe_error, consecutiveQuiet };
}
