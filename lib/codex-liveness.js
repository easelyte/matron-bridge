import fs from 'node:fs';

// `platform` is injectable purely so the non-Linux branch is unit-testable
// without mutating the global `process.platform`. Prod callers pass one arg,
// so Linux behaviour is byte-for-byte unchanged.
export function isWrapperAlive(meta, { platform = process.platform } = {}) {
  try {
    process.kill(meta.wrapperPid, 0);
  } catch {
    return false;
  }

  // Non-Linux (dev/macOS) has no /proc, so the start-tick identity check is
  // unavailable: fall back to kill(pid,0) liveness only. Documented residual —
  // PID reuse within deadlineTs cannot be detected here; acceptable under the
  // single-principal dev threat model and bounded by deadlineTs. Linux prod
  // keeps the start-tick identity check below (defeats PID reuse).
  if (platform !== 'linux') return true;

  try {
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
