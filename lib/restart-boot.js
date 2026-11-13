// What happens at boot after a planned restart. Every session that left a held
// note before the restart (a participant) is carried on with that note, one at
// a time, and the restart is marked `back` once each has a verdict.
//
// Delivery is at most once. An entry is marked `delivering` in the pending
// file before the hand-off and removed after it; a boot that finds a
// `delivering` entry does not deliver it again and records it as
// `possibly_delivered`. A hand-off that fails outright is retried after a
// minute, up to three attempts, then recorded as `failed`. A note is never
// turned into an ordinary timer: a restart-time timer could fire early.
export const RESTART_RESUME_PREFIX = '[auto-continue after planned bridge restart]';
const RETRY_MS = 60_000;
const MAX_ATTEMPTS = 3;

// The turn text a participant receives: the bridge's own words, then the note.
export function restartResumeText(entry, { codeMismatch = false, now = Date.now } = {}) {
  const minutes = Math.max(0, Math.round((now() - entry.writtenAt) / 60_000));
  const ago = minutes < 1 ? 'just before' : `${minutes} min before`;
  const code = codeMismatch ? ' The bridge booted onto different code than the restart expected.' : '';
  return `${RESTART_RESUME_PREFIX} The bridge restarted as planned and your turn was not cut off.${code} Your resume note (written ${ago} the restart): ${entry.text}`;
}

// `deliver(entry)` resolves to true once the text is handed to the session.
export function createRestartBoot({
  stateStore, notesStore, bootSha, maxAgeMs, deliver,
  now = Date.now, schedule = setTimeout, log = () => {}, firstDelayMs = 15_000, gapMs = 10_000,
}) {
  let reconciled = false;
  let started = false;

  const verdicts = state => state.verdicts ?? {};
  const results = state => ({
    verdicts: verdicts(state),
    code_mismatch: state.expected_sha != null && bootSha !== state.expected_sha,
  });

  function record(entry, outcome) {
    const state = stateStore.getState();
    if (entry.id !== state.id || Object.hasOwn(verdicts(state), entry.convoId)) return;
    stateStore.patch({ verdicts: { ...verdicts(state), [entry.convoId]: { outcome, at: now() } } });
  }

  // Back once every participant has a verdict (immediately when there are none).
  function finish() {
    const state = stateStore.getState();
    if (state.state !== 'restarting') return;
    if (!state.participants.every(id => Object.hasOwn(verdicts(state), id))) return;
    stateStore.setState('back', { results: results(state) });
    log('back');
  }

  function terminal(entry, outcome) {
    record(entry, outcome);
    notesStore.removePending(entry.id, entry.convoId);
    finish();
  }

  function validate(entries) {
    for (const entry of entries) {
      if ((entry.status !== undefined && !['pending', 'delivering'].includes(entry.status))
        || (entry.attempts !== undefined && (!Number.isInteger(entry.attempts) || entry.attempts < 0 || entry.attempts > MAX_ATTEMPTS))
        || (entry.retry_at !== undefined && !Number.isFinite(entry.retry_at))) {
        throw new Error('Invalid restart delivery');
      }
    }
    return entries;
  }

  // A hand-off that throws before it is marked `delivering` (an unreadable or
  // unwritable notes file) is retried with a growing delay, three times in all.
  // Then the participant is recorded as failed so the restart is released.
  const thrown = new Map();
  function giveUp(entry) {
    log('Planned restart recovery failed; giving up on a delivery');
    try {
      record({ id: entry.id, convoId: entry.convoId }, 'failed');
      notesStore.removePending(entry.id, entry.convoId);
      finish();
    } catch {
      // The stores themselves are unusable: release the restart anyway.
      try { stateStore.setState('back', { results: { recovery_failed: true } }); } catch { /* nothing left to try */ }
    }
  }

  function scheduleHandoff(entry, delay) {
    schedule(() => handoff(entry).catch(() => {
      const count = (thrown.get(entry.convoId) ?? 0) + 1;
      thrown.set(entry.convoId, count);
      if (count >= MAX_ATTEMPTS) { giveUp(entry); return; }
      log('Planned restart recovery degraded; delivery remains pending');
      scheduleHandoff(entry, RETRY_MS * count);
    }), delay);
  }

  async function handoff(queued) {
    const state = stateStore.getState();
    const entry = validate(notesStore.listPending(state.id)).find(note => note.convoId === queued.convoId);
    if (!entry) {
      // The entry vanished without a verdict (the notes file was removed).
      record({ id: state.id, convoId: queued.convoId }, 'failed');
      finish();
      return;
    }
    if (Object.hasOwn(verdicts(state), entry.convoId)) { notesStore.removePending(entry.id, entry.convoId); finish(); return; }
    if (entry.status === 'delivering') { terminal(entry, 'possibly_delivered'); return; }
    if ((entry.attempts ?? 0) >= MAX_ATTEMPTS) { terminal(entry, 'failed'); return; }
    notesStore.putPending({ ...entry, status: 'delivering' });
    const text = restartResumeText(entry, { codeMismatch: results(state).code_mismatch, now });
    const delivered = await Promise.resolve().then(() => deliver({ ...entry, text })).then(result => result === true, () => false);
    if (delivered) { terminal(entry, 'resumed'); return; }
    const attempts = (entry.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) { terminal(entry, 'failed'); return; }
    const retry = { ...entry, attempts, status: 'pending', retry_at: now() + RETRY_MS };
    notesStore.putPending(retry);
    scheduleHandoff(retry, RETRY_MS);
  }

  return {
    // Synchronous, before any input or timer: decide what this boot owes.
    reconcile() {
      let state = stateStore.getState();
      validate(notesStore.listPending());
      if (state.state !== 'restarting') { reconciled = true; return; }
      const age = now() - state.restarting_at;
      if (!Number.isFinite(age) || age > maxAgeMs) {
        // Too old to resume anyone: the work the notes describe has moved on.
        for (const convoId of state.participants) {
          record({ id: state.id, convoId }, 'stale');
          notesStore.removePending(state.id, convoId);
          notesStore.removeHeld(state.id, convoId);
        }
        state = stateStore.getState();
        stateStore.setState('back', { results: results(state) });
        log('back (restart too old to resume anyone)');
        reconciled = true;
        return;
      }
      // Pending is written before held is cleared; a note found in both is
      // delivered once.
      notesStore.moveToPending(state.id);
      const pending = notesStore.listPending(state.id);
      for (const entry of pending) {
        if (entry.status === 'delivering') terminal(entry, 'possibly_delivered');
      }
      // A participant whose note is gone can never be carried on: say so
      // rather than leave the restart waiting for it.
      for (const convoId of state.participants) {
        if (!pending.some(entry => entry.convoId === convoId)) record({ id: state.id, convoId }, 'failed');
      }
      reconciled = true;
      finish();
    },

    // Once the local API listens: carry participants on, one at a time.
    start() {
      // The notes only reach the pending file in reconcile().
      if (!reconciled) throw new Error('Restart boot is not reconciled');
      if (started) return;
      started = true;
      const state = stateStore.getState();
      if (state.state !== 'restarting') return;
      notesStore.listPending(state.id).forEach((entry, index) => {
        scheduleHandoff(entry, Math.max(firstDelayMs + index * gapMs, (entry.retry_at ?? 0) - now()));
      });
    },
  };
}
