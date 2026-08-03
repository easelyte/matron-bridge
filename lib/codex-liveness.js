import fs from 'node:fs';

export function isWrapperAlive(meta) {
  try {
    process.kill(meta.wrapperPid, 0);

    const stat = fs.readFileSync(`/proc/${meta.wrapperPid}/stat`, 'utf8');
    const lastCommDelimiter = stat.lastIndexOf(')');
    if (lastCommDelimiter === -1) return false;

    const fieldsAfterComm = stat.slice(lastCommDelimiter + 1).trim().split(/\s+/);
    const startTicks = fieldsAfterComm[19];
    return startTicks !== undefined && startTicks === String(meta.wrapperStartTicks);
  } catch {
    return false;
  }
}

export function pastDeadline(meta, now) {
  return now > meta.deadlineTs;
}
