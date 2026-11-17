// Delivery of resume notes after a restart, with retry and backoff.
//
// Upstream's resume notes (lib/restart-notes.js) are taken from disk at boot
// and delivered once, 15 seconds later; if that one delivery fails (the chat
// cannot be resumed yet, its input is held by a sign-in dialog, the PTY is
// not ready) the note is gone and nothing resumes the chat. This keeps the
// fork's earlier delivery rules on top of the same notes:
//
//   * every note is written to a pending file before anything is delivered,
//     and stays there, with its outcome, until the restart record has been
//     closed (a crash loses neither a note nor what became of it);
//   * a delivery that is deferred (the session is busy, not ready or holding
//     input) is tried again after a minute and costs no attempt;
//   * a delivery that fails is tried again after a minute, three times in
//     all, then the chat gets a "Carry on" card instead (the recovery card:
//     the note replaced the card the chat would otherwise have had);
//   * a note is marked `delivering` BEFORE it is handed over, so a crash
//     during the hand-over is never answered with a second delivery: it is
//     recorded as possibly delivered;
//   * a note older than a day is dropped.
//
// Outcomes (`resumed`, `failed`, `possibly_delivered`, `stale`) are reported
// once everything has settled, and only after intake is complete (the boot
// code has said it has taken every note it is going to take). They are
// reported per restart record (`owner`, the id of the record the note was
// taken for) and become that record's `results`. The entries are removed only
// when the report has been acknowledged; if it was not, it is made again.
//
// The pending file keeps the shape the fork's earlier notes used (id,
// convoId, text, writtenAt, status, attempts, retry_at), so entries left by
// an earlier version are delivered by this one. A note is identified by its
// conversation and its write time, so a note taken twice (a crash between
// writing it here and removing it from upstream's file) is delivered once.
//
// Everything impure is injected, so the policy tests without timers or a bridge.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic-write.js';

export const DEFAULT_PENDING_FILE = path.join(os.homedir(), '.matron-bridge-restart-pending.json');
export const NOTE_MAX_ATTEMPTS = 3;
export const NOTE_RETRY_MS = 60_000;
export const NOTE_FIRST_DELAY_MS = 15_000;
export const NOTE_STAGGER_MS = 10_000;
export const NOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Worst first: when a chat has more than one outcome in a report, this one is kept.
const SEVERITY = ['failed', 'possibly_delivered', 'stale', 'resumed'];
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const valid = (e) => !!e && typeof e === 'object' && text(e.convoId) && text(e.text) && Number.isFinite(e.writtenAt)
  && (e.status === undefined || ['pending', 'delivering', 'done'].includes(e.status))
  && (e.status !== 'done' || (SEVERITY.includes(e.outcome) && Number.isFinite(e.outcome_at)))
  && (e.attempts === undefined || (Number.isInteger(e.attempts) && e.attempts >= 0 && e.attempts <= NOTE_MAX_ATTEMPTS))
  && (e.retry_at === undefined || Number.isFinite(e.retry_at))
  && (e.owner === undefined || e.owner === null || text(e.owner));
const open = (e) => e.status !== 'done';
const idOf = (e) => `${e.convoId}\u0000${e.writtenAt}`;
const worse = (a, b) => (!a || SEVERITY.indexOf(b.outcome) < SEVERITY.indexOf(a.outcome) ? b : a);

// deliver(entry) -> true (handed to the session) | { deferred: true } | false.
//   A throw counts as false. entry = { convoId, text, writtenAt, interrupted }.
// recover(entry) publishes the recovery card for a note that could not be
//   delivered. A throw is logged; the card is best effort.
// onSettled(outcomes, owner) -> true when the restart record `owner` has been
//   closed with { [convoId]: { outcome, at } }. Anything else is tried again.
// owner() -> the id of the restart record notes taken now belong to, or null.
export function createNoteDelivery({
  deliver, recover = () => {}, onSettled = () => true, owner = () => null,
  file = DEFAULT_PENDING_FILE, fs = nodeFs, now = Date.now, schedule = setTimeout,
  log = () => {}, maxAgeMs = NOTE_MAX_AGE_MS, maxAttempts = NOTE_MAX_ATTEMPTS, retryMs = NOTE_RETRY_MS,
  firstDelayMs = NOTE_FIRST_DELAY_MS, staggerMs = NOTE_STAGGER_MS,
}) {
  const armed = new Set();
  // Outcomes that could not be written to the file (intake failed): kept here
  // and reported with the rest.
  let memory = [];
  let intake = false;
  let begun = false;
  let settleRetry = false;
  let settled = false;

  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    let data;
    try { data = JSON.parse(raw); } catch {
      // Keep the evidence, start empty: a corrupt file must not block every restart's notes.
      try { fs.renameSync(file, `${file}.corrupt-${now()}`); } catch { /* the next write replaces it */ }
      log('[restart-note] pending file was not valid JSON; moved aside');
      return [];
    }
    if (!Array.isArray(data)) return [];
    const kept = data.filter(valid);
    if (kept.length !== data.length) log(`[restart-note] dropped ${data.length - kept.length} invalid pending note(s)`);
    return kept;
  }
  const write = (entries) => atomicWriteFileSync(file, JSON.stringify(entries), { fs, mode: 0o600 });
  const put = (entry) => write([...read().filter(e => idOf(e) !== idOf(entry)), entry]);
  const find = (id) => read().find(e => idOf(e) === id);

  // The note reached an outcome. It stays in the file, with the outcome, until
  // the restart record has been closed.
  function finish(entry, outcome) {
    const done = { ...entry, status: 'done', outcome, outcome_at: now(), ...(outcome === 'failed' ? { card: 'due' } : {}) };
    delete done.retry_at;
    put(done);
    if (outcome === 'failed') card(done);
  }

  function card(entry) {
    try { recover(entry); } catch (e) { log(`[restart-note] recovery card failed for ${entry.convoId}: ${e?.message ?? e}`); }
    try { put({ ...entry, card: 'done' }); } catch { /* shown again at the next boot, which is harmless */ }
  }

  // Everything is reported together, grouped by the record it belongs to.
  function checkSettled() {
    if (settled || !intake || !begun || armed.size) return;
    const entries = read();
    if (entries.some(open)) return;
    const reports = new Map();
    const add = (ownerId, convoId, outcome, at) => {
      const group = reports.get(ownerId ?? null) ?? new Map();
      const kept = group.get(convoId);
      group.set(convoId, worse(kept && { outcome: kept.outcome, at: kept.at }, { outcome, at }));
      reports.set(ownerId ?? null, group);
    };
    for (const e of entries) add(e.owner, e.convoId, e.outcome, e.outcome_at);
    for (const m of memory) add(m.owner, m.convoId, m.outcome, m.at);
    if (!reports.size && !entries.length && !memory.length) reports.set(null, new Map());
    let ok = true;
    for (const [ownerId, group] of reports) {
      let acknowledged = false;
      try { acknowledged = onSettled(Object.fromEntries(group), ownerId) === true; } catch (e) { log(`[restart-note] settle failed: ${e?.message ?? e}`); }
      if (!acknowledged) ok = false;
    }
    if (ok) {
      settled = true;
      memory = [];
      if (entries.length) { try { write([]); } catch (e) { log(`[restart-note] could not clear the settled notes: ${e?.message ?? e}`); } }
      return;
    }
    // Not closed: keep everything and look again in a minute (and at the next boot).
    if (!settleRetry) {
      settleRetry = true;
      schedule(() => { settleRetry = false; checkSettled(); }, retryMs);
    }
  }

  function arm(id, delayMs) {
    armed.add(id);
    schedule(() => {
      handoff(id).catch((e) => {
        // The entry stays on disk as it was; look again in a minute.
        log(`[restart-note] delivery step failed: ${e?.message ?? e}`);
        arm(id, retryMs);
      });
    }, Math.max(0, delayMs));
  }

  async function handoff(id) {
    armed.delete(id);
    const entry = find(id);
    if (!entry || !open(entry)) { checkSettled(); return; }
    if (entry.status === 'delivering') {
      // Handed over before a crash: possibly delivered, never delivered twice.
      finish(entry, 'possibly_delivered');
      checkSettled();
      return;
    }
    if (now() - entry.writtenAt >= maxAgeMs) { finish(entry, 'stale'); checkSettled(); return; }
    if ((entry.attempts || 0) >= maxAttempts) { finish(entry, 'failed'); checkSettled(); return; }
    put({ ...entry, status: 'delivering' });
    let result;
    try { result = await deliver(entry); } catch { result = false; }
    if (result === true) { finish(entry, 'resumed'); checkSettled(); return; }
    if (now() - entry.writtenAt >= maxAgeMs) { finish(entry, 'stale'); checkSettled(); return; }
    const deferred = result && result.deferred === true;
    const attempts = (entry.attempts || 0) + (deferred ? 0 : 1);
    if (attempts >= maxAttempts) { finish({ ...entry, attempts }, 'failed'); checkSettled(); return; }
    put({ ...entry, status: 'pending', attempts, retry_at: now() + retryMs });
    arm(id, retryMs);
  }

  // Arm everything on disk. Entries a crash left `delivering` are settled as
  // possibly delivered at once; the rest wait their turn, staggered so a
  // restart with many chats does not resume them all in the same second.
  function begin() {
    begun = true;
    const all = read();
    for (const entry of all.filter(e => e.status === 'delivering' && !armed.has(idOf(e)))) finish(entry, 'possibly_delivered');
    for (const entry of all.filter(e => e.status === 'done' && e.card === 'due')) card(entry);
    const waiting = all.filter(e => e.status !== 'delivering' && e.status !== 'done');
    const width = waiting.length > 10 ? 2 : 1;
    waiting.forEach((entry, index) => {
      if (armed.has(idOf(entry))) return;
      const staggered = firstDelayMs + Math.floor(index / width) * staggerMs;
      arm(idOf(entry), Math.max(staggered, (entry.retry_at || 0) - now()));
    });
    checkSettled();
  }

  return {
    // Persist the notes taken at boot (lib/restart-notes.js takeNoteDeliveries),
    // then deliver. Throws only when they cannot be made durable, before
    // anything was written: the caller then reports them with failIntake().
    // A note already here (same conversation, same write time) is not added
    // again; a newer note for a conversation replaces its older pending one
    // (outcomes already reached are kept).
    start(deliveries) {
      const existing = read();
      const ownerId = owner();
      const added = deliveries.map(d => ({
        convoId: d.convoId, text: d.text, writtenAt: Number.isFinite(d.writtenAt) ? d.writtenAt : now() - Math.max(0, d.ageMs || 0),
        interrupted: !!d.interrupted, status: 'pending', attempts: 0, ...(ownerId ? { owner: ownerId } : {}),
      })).filter(n => !existing.some(e => idOf(e) === idOf(n)));
      write([...existing.filter(e => !(open(e) && added.some(n => n.convoId === e.convoId))), ...added]);
      if (added.length) settled = false;
      intake = true;
      try { begin(); } catch (e) { log(`[restart-note] could not start delivery: ${e?.message ?? e}`); }
    },
    // Notes that could not be queued: the caller has handed their chats a card;
    // they are reported as failed with everything else.
    failIntake(deliveries) {
      const ownerId = owner();
      for (const d of deliveries) memory.push({ convoId: d.convoId, outcome: 'failed', at: now(), owner: ownerId });
      settled = false;
    },
    // The boot code has taken every note it is going to take (there may have
    // been none). Settlement waits for this.
    intakeComplete() { intake = true; checkSettled(); },
    // Whatever an earlier process left: deliver it, and settle when done.
    resume() { begin(); },
    pendingCount: () => read().filter(open).length,
  };
}
