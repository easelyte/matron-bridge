export const RESTART_RESUME_TEXT = 'The bridge restarted. Carry on from where you left off.';

// Synchronous reconciliation precedes input and timer initialization. Every
// handoff is bracketed by durable writes so an uncertain delivery is never
// replayed after a crash. All effects are injected for recovery testing.
export function createRestartBoot({
  stateStore, notesStore, markerStore, bootId, bootSha, maxAgeMs,
  now = Date.now, schedule = setTimeout,
  deliver, takeStamp, log = () => {}, resumeCancel = async () => {}, history = stateStore, onStep = () => {},
}) {
  let stamp;
  let reconciled = false;
  let ready = false;
  let cardParticipants = new Set();
  let previousBootId;
  const deferredIds = new Set();
  const deliveryKey = entry => JSON.stringify([entry.id, entry.convoId]);
  const verdicts = (state, id) => id === state.id ? state.verdicts : state.other_verdicts?.[id] || {};

  function record(entry, outcome) {
    const state = stateStore.getState();
    const prior = verdicts(state, entry.id);
    if (Object.hasOwn(prior, entry.convoId)) return;
    const next = { ...prior, [entry.convoId]: { outcome, at: now() } };
    if (entry.id === state.id) stateStore.patch({ verdicts: next });
    else stateStore.patch({ other_verdicts: { ...state.other_verdicts, [entry.id]: next } });
  }

  function results(state) {
    return {
      verdicts: state.verdicts,
      no_note: Object.keys(state.notified).filter(id => !state.participants.includes(id)),
      code_mismatch: state.expected_sha != null && bootSha !== state.expected_sha,
    };
  }

  function append(state) {
    if (!state.history_appended) history.appendHistoryOnce(state.id, {
      ...state, abandoned: state.state === 'abandoned',
    });
  }

  function finish() {
    const state = stateStore.getState();
    if (['back', 'abandoned'].includes(state.state)) { append(state); return; }
    if (state.state !== 'restarting'
      || !state.participants.every(id => Object.hasOwn(state.verdicts, id))) return;
    const back = stateStore.setState('back', { results: results(state) });
    onStep('back');
    append(back);
  }

  function terminal(entry, outcome) {
    record(entry, outcome);
    onStep('verdict');
    notesStore.removePending(entry.id, entry.convoId);
    deferredIds.delete(deliveryKey(entry));
    finish();
  }

  function expire(entry) {
    const state = stateStore.getState();
    if (entry.id !== state.id || state.state !== 'restarting'
      || now() - state.restarting_at < maxAgeMs) return false;
    terminal(entry, 'stale');
    return true;
  }

  function validate(entries) {
    for (const entry of entries) {
      if ((entry.status !== undefined && !['pending', 'delivering'].includes(entry.status))
        || (entry.attempts !== undefined && (!Number.isInteger(entry.attempts) || entry.attempts < 0 || entry.attempts > 3))
        || (entry.retry_at !== undefined && !Number.isFinite(entry.retry_at))) {
        throw new Error('Invalid restart delivery');
      }
    }
    return entries;
  }

  function scheduleHandoff(entry, delay) {
    schedule(() => handoff(entry).catch(() => {
      log('Planned restart recovery degraded; delivery remains pending');
      scheduleHandoff(entry, 60000);
    }), delay);
  }

  async function handoff(entry) {
    const current = validate(notesStore.listPending(entry.id)).find(note => note.convoId === entry.convoId);
    if (!current) { finish(); return; }
    if (Object.hasOwn(verdicts(stateStore.getState(), entry.id), entry.convoId)) {
      notesStore.removePending(entry.id, entry.convoId);
      finish();
      return;
    }
    const key = deliveryKey(current);
    if (deferredIds.has(key)) {
      const retry = { ...current, status: 'pending', retry_at: now() + 60000 };
      notesStore.putPending(retry);
      deferredIds.delete(key);
      scheduleHandoff(retry, 60000);
      return;
    }
    if (current.status === 'delivering') { terminal(current, 'possibly_delivered'); return; }
    if (expire(current)) return;
    if (current.attempts >= 3) { terminal(current, 'failed'); return; }
    notesStore.putPending({ ...current, status: 'delivering' });
    onStep('delivering');
    let outcome;
    try {
      const result = await deliver(current);
      outcome = result === true ? 'resumed' : result?.deferred === true ? 'deferred' : 'retry';
    }
    catch { outcome = 'retry'; }
    if (outcome === 'deferred') deferredIds.add(key);
    onStep('handed_off');
    if (outcome === 'resumed') { terminal(current, outcome); return; }
    if (expire(current)) return;
    const attempts = (current.attempts || 0) + (outcome === 'deferred' ? 0 : 1);
    if (attempts >= 3) { terminal(current, 'failed'); return; }
    const retry = { ...current, attempts, status: 'pending', retry_at: now() + 60000 };
    notesStore.putPending(retry);
    deferredIds.delete(key);
    scheduleHandoff(retry, 60000);
  }

  return {
    get stamp() { return stamp; },
    suppressCard: (convoId, markerBootId) => cardParticipants.has(convoId)
      && typeof previousBootId === 'string' && markerBootId === previousBootId,
    reconcile() {
      if (reconciled) return;
      let state = stateStore.getState();
      if (state.state === 'restarting' && (!Number.isFinite(state.restarting_at)
        || typeof state.expected_sha !== 'string' || !state.expected_sha || !Array.isArray(state.participants))) {
        state = stateStore.setState('pending', { restarting_at: null, expected_sha: null,
          participants: [], stamp_written: false, boot_phase: null });
        log('Planned restart recovery: incomplete restart reverted to pending');
      }
      // A latch whose un-latch write failed stays `restarting` on disk but never
      // reached the shutdown commit point (null, not absent: older bridges did
      // not stamp it and are treated as genuine). Revert it to pending.
      if (state.state === 'restarting' && state.shutdown_committed_at === null) {
        state = stateStore.setState('pending', { restarting_at: null, expected_sha: null,
          participants: [], stamp_written: false, boot_phase: null, shutdown_committed_at: undefined });
        log('Planned restart recovery: stale latch (shutdown never committed) reverted to pending');
      }
      // A pending request for the sha this process already booted was satisfied
      // by an unplanned restart. Drop it and its held notes; the legacy in-flight
      // carry-on card is then the only continuation path for interrupted chats.
      if (state.state === 'pending' && typeof bootSha === 'string' && bootSha
        && state.requests.some(request => request?.sha === bootSha)) {
        const remaining = state.requests.filter(request => request?.sha !== bootSha);
        if (remaining.length) {
          state = stateStore.patch({ requests: remaining });
        } else {
          // Chats with an in-flight marker continue through the legacy carry-on
          // path; their held note would duplicate it. Notes of chats without a
          // marker are the only continuation they have: keep them for delivery.
          const marked = markerStore.list();
          for (const note of notesStore.listHeld(state.id)) {
            if (Object.hasOwn(marked, note.convoId)) notesStore.removeHeld(state.id, note.convoId);
          }
          notesStore.moveToPending(state.id);
          state = stateStore.setState('cancelled', { requests: [] });
        }
        log('Planned restart recovery: request already satisfied by an unplanned restart; dropped');
      }
      validate(notesStore.listPending());
      notesStore.listHeld(state.id);
      markerStore.list();
      cardParticipants = new Set(state.state === 'restarting' ? state.participants : []);
      previousBootId = state.boot_id;
      stateStore.patch({ boot_phase: { bootId, phase: 'reconciling' }, stamp_written: false });
      onStep('reconciling');
      stamp = takeStamp();
      onStep('stamp_taken');
      if (state.state === 'cancelling') {
        Promise.resolve().then(resumeCancel).catch(() => log('Planned restart cancellation remains pending'));
      } else if (state.state === 'restarting') {
        if (now() - state.restarting_at > maxAgeMs) {
          for (const convoId of state.participants) {
            record({ id: state.id, convoId }, 'stale');
            notesStore.removePending(state.id, convoId);
            notesStore.removeHeld(state.id, convoId);
          }
          state = stateStore.getState();
          const abandoned = stateStore.setState('abandoned', { results: results(state) });
          append(abandoned);
        } else {
          notesStore.moveToPending(state.id);
          onStep('held_rewritten');
          for (const convoId of state.participants) {
            if (!notesStore.listPending(state.id).some(entry => entry.convoId === convoId)
              && !Object.hasOwn(state.verdicts, convoId)) {
              notesStore.putPending({ id: state.id, convoId, text: RESTART_RESUME_TEXT, writtenAt: now() });
              onStep('marker_entry');
            }
          }
          stateStore.setBootPhase('notes_moved');
          onStep('notes_moved');
        }
      } else if (['back', 'abandoned'].includes(state.state)) append(stateStore.getState());
      // Reconcile uncertain and already-verdict deliveries before arming any
      // timer, including entries left by an older restart id.
      for (const entry of notesStore.listPending()) {
        if (Object.hasOwn(verdicts(stateStore.getState(), entry.id), entry.convoId)) {
          notesStore.removePending(entry.id, entry.convoId);
        } else if (entry.status === 'delivering') terminal(entry, 'possibly_delivered');
      }
      reconciled = true;
    },
    listenerReady() {
      if (!reconciled) throw new Error('Restart boot is not reconciled');
      if (ready) return;
      const state = stateStore.getState();
      if (state.state === 'restarting' && state.booted_at == null) {
        stateStore.setBootPhase('booted');
        onStep('booted');
      }
      finish();
      const entries = notesStore.listPending();
      const width = Math.max(state.participants.length, entries.length) > 10 ? 2 : 1;
      entries.forEach((entry, index) => {
        const delay = Math.max(15000 + Math.floor(index / width) * 10000, (entry.retry_at || 0) - now());
        scheduleHandoff(entry, delay);
      });
      ready = true;
    },
  };
}

// A notice must leave the publisher queue before its held note is removed.
// Progress and stable keys make every interrupted step safe to retry.
export function createRestartCancellation({ stateStore, notesStore, publishText, timeoutMs = 2000 }) {
  let running;
  async function resume() {
    let state = stateStore.getState();
    if (state.state === 'pending') {
      const participants = notesStore.listHeld(state.id).map(note => note.convoId);
      state = stateStore.setState('cancelling', { cancel_participants: participants, cancel_done: [] });
    }
    if (state.state !== 'cancelling') return state;
    for (const convoId of state.cancel_participants) {
      if (state.cancel_done.includes(convoId)) continue;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Restart cancellation notice timed out')), timeoutMs);
        const done = error => { clearTimeout(timer); if (error) reject(error); else resolve(); };
        try {
          if (publishText(convoId, { body: 'The planned bridge restart was cancelled.', from: 'assistant' }, {
            idemKey: `restart-cancel:${state.id}:${convoId}`,
            onDelivered: () => done(), onEvicted: () => done(new Error('Restart cancellation notice evicted')),
          }) !== true) done(new Error('Restart cancellation notice refused'));
        } catch (error) { done(error); }
      });
      notesStore.removeHeld(state.id, convoId);
      state = stateStore.patch({ cancel_done: [...state.cancel_done, convoId] });
    }
    return stateStore.setState('cancelled', { requests: [] });
  }
  return () => {
    if (!running) running = resume().finally(() => { running = undefined; });
    return running;
  };
}

// When planned-restart recovery goes down at boot (token file unwritable, or
// listener setup failed), nothing will deliver the notes reconcile moved to the
// pending list. Chats with an in-flight marker get the ordinary carry-on card;
// this takes the notes of the rest ("note-only" chats) off the list so each can
// be handed a card instead. Notes are removed whether or not a card is possible.
export function takeNoteOnlyRecoveries({ stateStore, notesStore, markerIds = new Set(), isResumable = () => true }) {
  // Record the terminal verdicts first: a later boot's reconcile recreates a
  // marker note for any participant without one and would resume the chat again.
  const state = stateStore.getState();
  const decided = (id, convoId) => Object.hasOwn(
    id === state.id ? state.verdicts : state.other_verdicts?.[id] || {}, convoId);
  // Held notes count too: a failed held-to-pending move leaves them behind, and
  // nothing migrates them once the restart is no longer `restarting`.
  // Each source is read independently: an unreadable one must not disable the other.
  let held = [];
  try { held = state.id ? notesStore.listHeld(state.id) : []; } catch { /* pending notes still recover */ }
  const notes = [...notesStore.listPending(), ...held];
  if (state.state === 'restarting') {
    const verdicts = { ...state.verdicts };
    for (const convoId of state.participants) {
      if (!Object.hasOwn(verdicts, convoId)) verdicts[convoId] = { outcome: 'failed', at: Date.now() };
    }
    stateStore.setState('abandoned', { verdicts, results: { verdicts, recovery_unavailable: true } });
  }
  // Pick the card targets before touching storage: a failed removal must not
  // cost the remaining chats their card. A chat that already holds a verdict
  // was handed its card (or finished) on an earlier call: never card it twice.
  const convoIds = [...new Set(notes.filter(note => !decided(note.id, note.convoId)).map(note => note.convoId))]
    .filter(id => !markerIds.has(id) && isResumable(id));
  for (const note of notes) {
    try { notesStore.removePending(note.id, note.convoId); } catch { /* verdict check drops it at the next boot */ }
    try { notesStore.removeHeld(note.id, note.convoId); } catch { /* same */ }
  }
  return convoIds;
}
