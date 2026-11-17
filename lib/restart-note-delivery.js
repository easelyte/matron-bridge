// Delivery of resume notes after a restart, with retry and backoff.
//
// Upstream's resume notes (lib/restart-notes.js) are taken from disk at boot
// and delivered once, 15 seconds later; if that one delivery fails (the chat
// cannot be resumed yet, its input is held by a sign-in dialog, the PTY is
// not ready) the note is gone and nothing resumes the chat. This keeps the
// fork's earlier delivery rules on top of the same notes:
//
//   * every note is written to a pending file before anything is delivered
//     (a crash mid-retry loses nothing);
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
// once everything has settled: they become the `results` of the restart in
// the state file, its history line and the journal's `restart` block.
//
// The pending file keeps the shape the fork's earlier notes used (id,
// convoId, text, writtenAt, status, attempts, retry_at), so entries left by
// an earlier version are delivered by this one.
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

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const valid = (e) => !!e && typeof e === 'object' && text(e.convoId) && text(e.text) && Number.isFinite(e.writtenAt)
  && (e.status === undefined || e.status === 'pending' || e.status === 'delivering')
  && (e.attempts === undefined || (Number.isInteger(e.attempts) && e.attempts >= 0 && e.attempts <= NOTE_MAX_ATTEMPTS))
  && (e.retry_at === undefined || Number.isFinite(e.retry_at));

// deliver(entry) -> true (handed to the session) | { deferred: true } | false.
//   A throw counts as false. entry = { convoId, text, writtenAt, interrupted }.
// recover(entry) is called once for a note that could not be delivered, to
//   publish the recovery card. A throw is logged and does not stop the rest.
// onSettled(outcomes) is called once the queue is empty: { [convoId]: { outcome, at } }.
export function createNoteDelivery({
  deliver, recover = () => {}, onSettled = () => {},
  file = DEFAULT_PENDING_FILE, fs = nodeFs, now = Date.now, schedule = setTimeout,
  log = () => {}, maxAgeMs = NOTE_MAX_AGE_MS, maxAttempts = NOTE_MAX_ATTEMPTS, retryMs = NOTE_RETRY_MS,
  firstDelayMs = NOTE_FIRST_DELAY_MS, staggerMs = NOTE_STAGGER_MS,
}) {
  const outcomes = {};
  const armed = new Set();
  let reported = false;

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
  // One note per conversation, the newest wins.
  function dedupe(entries) {
    const byConvo = new Map();
    for (const e of entries) {
      const prior = byConvo.get(e.convoId);
      if (!prior || e.writtenAt >= prior.writtenAt) byConvo.set(e.convoId, e);
    }
    return [...byConvo.values()];
  }
  const put = (entry) => {
    const entries = read().filter(e => e.convoId !== entry.convoId);
    entries.push(entry);
    write(entries);
  };
  const remove = (convoId) => write(read().filter(e => e.convoId !== convoId));
  const find = (convoId) => read().find(e => e.convoId === convoId);
  const record = (convoId, outcome) => { outcomes[convoId] = { outcome, at: now() }; };

  function checkSettled() {
    if (reported || armed.size) return;
    if (read().length) return;
    reported = true;
    try { onSettled({ ...outcomes }); } catch (e) { log(`[restart-note] settle failed: ${e?.message ?? e}`); }
  }

  function fail(entry) {
    record(entry.convoId, 'failed');
    remove(entry.convoId);
    try { recover(entry); } catch (e) { log(`[restart-note] recovery card failed for ${entry.convoId}: ${e?.message ?? e}`); }
  }

  function arm(convoId, delayMs) {
    armed.add(convoId);
    schedule(() => {
      handoff(convoId).catch((e) => {
        // The entry stays on disk as it was; look again in a minute.
        log(`[restart-note] delivery step failed for ${convoId}: ${e?.message ?? e}`);
        arm(convoId, retryMs);
      });
    }, Math.max(0, delayMs));
  }

  async function handoff(convoId) {
    armed.delete(convoId);
    const entry = find(convoId);
    if (!entry) { checkSettled(); return; }
    if (entry.status === 'delivering') {
      // Handed over before a crash: possibly delivered, never delivered twice.
      record(convoId, 'possibly_delivered');
      remove(convoId);
      checkSettled();
      return;
    }
    if (now() - entry.writtenAt >= maxAgeMs) {
      record(convoId, 'stale');
      remove(convoId);
      checkSettled();
      return;
    }
    if ((entry.attempts || 0) >= maxAttempts) { fail(entry); checkSettled(); return; }
    put({ ...entry, status: 'delivering' });
    let result;
    try { result = await deliver(entry); } catch { result = false; }
    if (result === true) {
      record(convoId, 'resumed');
      remove(convoId);
      checkSettled();
      return;
    }
    if (now() - entry.writtenAt >= maxAgeMs) {
      record(convoId, 'stale');
      remove(convoId);
      checkSettled();
      return;
    }
    const deferred = result && result.deferred === true;
    const attempts = (entry.attempts || 0) + (deferred ? 0 : 1);
    if (attempts >= maxAttempts) { fail({ ...entry, attempts }); checkSettled(); return; }
    put({ ...entry, status: 'pending', attempts, retry_at: now() + retryMs });
    arm(convoId, retryMs);
  }

  // Arm everything on disk. Entries a crash left `delivering` are settled as
  // possibly delivered at once; the rest wait their turn, staggered so a
  // restart with many chats does not resume them all in the same second.
  function begin() {
    const all = read();
    for (const entry of all.filter(e => e.status === 'delivering' && !armed.has(e.convoId))) {
      record(entry.convoId, 'possibly_delivered');
      remove(entry.convoId);
    }
    const entries = all.filter(e => e.status !== 'delivering');
    const width = entries.length > 10 ? 2 : 1;
    entries.forEach((entry, index) => {
      if (armed.has(entry.convoId)) return;
      const staggered = firstDelayMs + Math.floor(index / width) * staggerMs;
      arm(entry.convoId, Math.max(staggered, (entry.retry_at || 0) - now()));
    });
    checkSettled();
  }

  return {
    // Persist the notes taken at boot (lib/restart-notes.js takeNoteDeliveries),
    // then deliver. Throws when they cannot be made durable: the caller falls
    // back to the recovery card for every one of them.
    start(deliveries) {
      const entries = deliveries.map(d => ({
        convoId: d.convoId, text: d.text, writtenAt: now() - Math.max(0, d.ageMs || 0),
        interrupted: !!d.interrupted, status: 'pending', attempts: 0,
      }));
      write(dedupe([...read().filter(e => !entries.some(n => n.convoId === e.convoId)), ...entries]));
      begin();
    },
    // At boot with nothing new: whatever an earlier process left.
    resume() { begin(); },
    pendingCount: () => read().length,
  };
}
