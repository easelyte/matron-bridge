// All latch work is synchronous. Input invalidates the attempt before any
// dispatch; a failed durable revert must never authorize shutdown.
export function createRestartLatch({
  stateStore, runtime, quiet, readCode, cacheKey, getPreflight,
  listHeld, listMarkers, writeStamp, deleteStamp, publishRestartStatus,
  gracefulShutdown, bootId, available = () => true, now = Date.now, log = () => {}, onStep = () => {},
}) {
  let inputsInFlight = 0;
  let active = false;
  let shutdownCommitted = false;
  let interrupted = false;
  let stampMayExist = false;
  let cleanupPending = false;

  function unlatch() {
    if (shutdownCommitted) return { latched: true };
    cleanupPending = true;
    stateStore.setState('pending', { restarting_at: null, expected_sha: null,
      stamp_written: false, boot_phase: null, participants: [] });
    interrupted = true;
    active = false;
    runtime.stamped = false;
    if (stampMayExist) {
      deleteStamp();
      stampMayExist = false;
    }
    cleanupPending = false;
    return { latched: false };
  }

  function step(name) {
    onStep(name);
    return active && !interrupted && !cleanupPending;
  }

  function onReady(verdict) {
    if (!available()) return { latched: false };
    try {
      if (cleanupPending) { unlatch(); return { latched: false }; }
      if (active) return { latched: false };
      if (stateStore.getState().state !== 'pending') return { latched: false };
      active = true;
      interrupted = false;
      if (!step('restarting')) return { latched: false };
      const observed = quiet();
      if (inputsInFlight > 0 || observed?.quiet !== true || observed.probe_error !== null
        || !Array.isArray(observed.holders) || observed.holders.length) return unlatch();
      if (!step('quiet')) return { latched: false };
      const checked = readCode(verdict.state.requests, verdict.state.boot_sha);
      if (checked?.code !== null || !checked.sha || checked.sha !== verdict.sha) return unlatch();
      const key = cacheKey(checked.sha);
      const preflight = getPreflight();
      const age = now() - preflight?.at;
      if (preflight?.status !== 'ok' || !key || !preflight.key
        || key.sha !== checked.sha || key.sha !== preflight.key.sha
        || key.env_hash !== preflight.key.env_hash || key.deps_stamp !== preflight.key.deps_stamp
        || !Number.isFinite(age) || age < 0 || age >= 300000) return unlatch();
      if (!step('code')) return { latched: false };
      const participants = [...new Set([...listHeld(verdict.state.id).map(note => note.convoId),
        ...Object.keys(listMarkers())])];
      stateStore.setState('restarting', { restarting_at: now(), expected_sha: checked.sha,
        previous_sha: verdict.state.boot_sha, boot_id: bootId, participants, stamp_written: true, history_appended: false });
      if (!step('persist')) return { latched: false };
      stampMayExist = true;
      writeStamp({ bootId, sha: checked.sha, busy: 0, at: now() });
      if (!active || interrupted || cleanupPending) return unlatch();
      runtime.stamped = true;
      if (!step('stamp')) return { latched: false };
      publishRestartStatus('restarting');
      if (!active || interrupted || cleanupPending) return { latched: false };
      log('Planned restart: quiet gate passed');
      if (!step('shutdown')) return { latched: false };
      shutdownCommitted = true;
      gracefulShutdown('planned-restart', { exitCode: 75 });
      return { latched: true };
    } catch {
      // Fixed messages at the integration boundary keep configuration and
      // filesystem exception details out of logs and box status.
      if (active || stampMayExist) {
        try { unlatch(); } catch { /* Durable state remains authoritative. */ }
      }
      try { log('Planned restart refused: latch failed'); } catch { /* Logging cannot authorize shutdown. */ }
      return { latched: false };
    }
  }

  function onInput() { if (!shutdownCommitted && (cleanupPending || (active && !interrupted))) unlatch(); }

  return {
    onReady,
    retryCleanup() { if (cleanupPending) unlatch(); },
    beginInput() {
      inputsInFlight++;
      try { onInput(); }
      catch (error) { inputsInFlight--; throw error; }
      return () => { inputsInFlight--; };
    },
    onInput,
    beforeRequest() {
      if (shutdownCommitted) return true;
      if (cleanupPending) unlatch();
      if (runtime.stamped) return true;
      if (active) { unlatch(); return false; }
      return stateStore.getState().state === 'restarting';
    },
  };
}
