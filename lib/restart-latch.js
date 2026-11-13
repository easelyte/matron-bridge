// The latch: the one synchronous step between "the gate passed" and "the
// process exits". Under the latch it re-reads quiet, the code and the
// preflight, records the restart as `restarting`, writes the stamp the next
// boot reads, and only then starts the shutdown. Any failure reverts the
// restart to `pending` and removes the stamp, so a restart that did not
// complete never leaves a stamp that claims a later crash.
import { RESTART_EXIT_CODE } from './code-update-restart.js';

export function createRestartLatch({
  stateStore, quiet, readCode, cacheKey, getPreflight, participants = () => [],
  writeStamp, deleteStamp, reportState = () => {}, gracefulShutdown, bootId,
  available = () => true, now = Date.now, log = () => {},
}) {
  let committed = false;
  let stampMayExist = false;

  // The stamp goes first, on its own: a failed state write must not leave a
  // stamp behind that would let a later crash of this process carry chats on.
  function revert() {
    if (committed) return;
    try {
      if (stampMayExist) { deleteStamp(); stampMayExist = false; }
    } finally {
      stateStore.setState('pending', { restarting_at: null, expected_sha: null, participants: [] });
    }
  }

  function onReady(verdict) {
    if (committed || !available()) return { latched: committed };
    try {
      if (stateStore.getState().state !== 'pending') return { latched: false };
      const observed = quiet();
      if (observed?.probe_error !== null || !Array.isArray(observed.holders) || observed.holders.length) return { latched: false };
      const checked = readCode(verdict.state.requests, verdict.state.boot_sha);
      if (checked?.code !== null || !checked.sha || checked.sha !== verdict.sha) return { latched: false };
      const key = cacheKey(checked.sha);
      const preflight = getPreflight();
      const age = now() - preflight?.at;
      if (preflight?.status !== 'ok' || !key || !preflight.key || key.sha !== preflight.key.sha
        || key.deps_stamp !== preflight.key.deps_stamp || !Number.isFinite(age) || age < 0 || age >= 300_000) return { latched: false };
      stateStore.setState('restarting', { restarting_at: now(), expected_sha: checked.sha,
        previous_sha: verdict.state.boot_sha, boot_id: bootId, participants: participants(verdict.state.id) });
      stampMayExist = true;
      writeStamp({ bootId, sha: checked.sha, busy: 0, reason: 'planned', restartId: verdict.state.id, at: now() });
      reportState('restarting');
      log('Planned restart: quiet gate passed');
      committed = true;
      gracefulShutdown('planned-restart', { exitCode: RESTART_EXIT_CODE });
      return { latched: true };
    } catch {
      // Fixed text: configuration and filesystem details stay out of logs.
      try { revert(); } catch { /* the durable state stays authoritative */ }
      try { log('Planned restart refused: latch failed'); } catch { /* logging cannot authorize shutdown */ }
      return { latched: false };
    }
  }

  return { onReady };
}
