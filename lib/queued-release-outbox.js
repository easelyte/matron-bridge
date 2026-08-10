import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Persistent, crash-safe write-ahead outbox for queued_release resolutions.
//
// The queued_release CARD is durable on the journal server (a persisted
// type:"prompt" event), but the machinery that RESOLVES it — the safePublish
// outbound queue and the in-memory release registry — is entirely process-local.
// A crash/overflow/unclean-shutdown between the queue mutation and the journal
// ack loses the release, leaving a durable card with no durable resolution.
//
// This module is the durability boundary. It is modelled on
// lib/subagent-running-store.js (same four-state readState, atomic tmp+rename
// saveAll, corrupt-quarantine, unreadable-refuse), with ONE deliberate
// divergence: it holds an IN-MEMORY `records` object as the ack source of
// truth. The echo-ack must flip a record unconditionally the instant the
// journal echo arrives (an echo is a one-shot edge — see spec §3 step 5), so
// the ack cannot depend on a disk write that might fail. The write-ahead `put`,
// by contrast, is STRICT: it commits in memory only on a durable disk write and
// returns false otherwise, so a failed durability prerequisite fail-closes the
// caller (emitRelease aborts before the irreversible queue mutation).
//
// Single-writer invariant: exactly one bridge process owns this file, so the
// in-memory cache never races another writer.
//
// Record key: `${promptId}\0${itemId}\0${action}` (deterministic; itemId keeps
// the schema forward-compatible with a future multi-item card).
// Lifecycle status: 'pending' -> 'acked'  (this-process happy path)
//                   'pending' -> 'pending_inherited' (relabelled at load in a
//                                NEW process; only boot reconcile touches it)
const DEFAULT_FILE = path.join(os.homedir(), '.claude-queued-release-outbox.json');

// Retention for acked records — an acked record only needs to outlive a
// plausible reconnect-replay window so a replayed echo can't resurrect it.
export const ACK_RETENTION_MS = 60 * 60 * 1000; // 1h

export function createQueuedReleaseOutbox({ file = DEFAULT_FILE, log = console } = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  // Four-state disk read (ported from subagent-running-store): empty / ok /
  // corrupt (quarantined aside) / unreadable (present-but-unreadable — refuse
  // to overwrite so records aren't erased).
  function readState() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { status: 'empty', data: {} };
      warn(`[queued-release-outbox] unreadable state file (${e?.code || e?.message}) — prior pending releases not reconciled this boot; refusing to overwrite`);
      return { status: 'unreadable', data: {} };
    }
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) return { status: 'ok', data };
      throw new Error('state file is not a JSON object');
    } catch (e) {
      const quarantine = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, quarantine);
        warn(`[queued-release-outbox] corrupt state file (${e.message}) — quarantined to ${quarantine}; prior pending releases not reconciled this boot`);
      } catch (renameErr) {
        warn(`[queued-release-outbox] corrupt state file (${e.message}) and quarantine failed (${renameErr.message}) — prior pending releases not reconciled this boot`);
        return { status: 'unreadable', data: {} };
      }
      return { status: 'corrupt', data: {} };
    }
  }

  // --- Load + state-gate relabel (synchronous, at construction) ---
  // Any record present at load was written by a PRIOR process (this process has
  // emitted nothing yet), so relabel every on-disk `pending` -> `pending_inherited`
  // deterministically, BEFORE the publisher can fire any hook. This is the state
  // gate: the retry driver skips `pending_inherited`; only boot reconcile touches
  // it. It removes any dependency on "reconcile runs before onReconnect" timing.
  const loaded = readState();
  const readOnly = loaded.status === 'unreadable';
  let records = {};
  for (const [key, rec] of Object.entries(loaded.data || {})) {
    if (!rec || typeof rec !== 'object') continue;
    records[key] = { ...rec };
    if (records[key].status === 'pending') records[key].status = 'pending_inherited';
  }

  // Atomic tmp+rename write of the given map. Returns true on a durable write.
  function saveAll(data) {
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      warn(`[queued-release-outbox] save failed: ${e.message}`);
      return false;
    }
  }

  return {
    // Write-ahead / upsert. STRICT: commits in memory ONLY on a durable disk
    // write; returns false otherwise so a caller (emitRelease) can fail-closed
    // and NOT proceed with the irreversible queue mutation. Preserves an
    // existing record's enqueuedAt (idempotent upsert). Refuses when the state
    // file was present-but-unreadable at load.
    put(key, rec) {
      if (typeof key !== 'string' || !key || !rec || typeof rec !== 'object') return false;
      if (readOnly) return false;
      const prior = records[key];
      const enqueuedAt = prior?.enqueuedAt ?? rec.at ?? Date.now();
      const candidate = { ...records, [key]: { ...rec, enqueuedAt } };
      if (!saveAll(candidate)) return false;
      records = candidate;
      return true;
    },

    // Echo-ack. BEST-EFFORT persist, but flips the matching in-memory records
    // UNCONDITIONALLY (a Map write that cannot fail). Matched by (promptId,
    // action) per spec §3 step 5 — universal across send/cancel/expired, and a
    // single echo covering multiple itemIds acks all sibling records. Never
    // throws. Returns the count flipped.
    markAcked(promptId, action) {
      let count = 0;
      const now = Date.now();
      for (const rec of Object.values(records)) {
        if (rec.promptId === promptId && rec.action === action && rec.status !== 'acked') {
          rec.status = 'acked';
          rec.ackedAt = now;
          count += 1;
        }
      }
      if (count > 0) saveAll(records); // best-effort; in-memory ack already authoritative
      return count;
    },

    // Drop a record (reconcile removes a settled inherited original). Refuses
    // when unreadable; no-op (true) when absent.
    remove(key) {
      if (typeof key !== 'string' || !key) return false;
      if (readOnly) return false;
      if (!(key in records)) return true;
      const candidate = { ...records };
      delete candidate[key];
      if (!saveAll(candidate)) return false;
      records = candidate;
      return true;
    },

    // Every record as { key, ...rec }. The reconcile + retry driver read this.
    list() {
      return Object.entries(records).map(([key, rec]) => ({ key, ...rec }));
    },

    // Retention sweep: drop `acked` records older than retentionMs (bounds file
    // growth). Best-effort persist.
    sweepAcked(retentionMs = ACK_RETENTION_MS, now = Date.now()) {
      let count = 0;
      const candidate = { ...records };
      for (const [key, rec] of Object.entries(candidate)) {
        if (rec.status !== 'acked') continue;
        const stamp = rec.ackedAt ?? rec.at ?? 0;
        if (now - stamp > retentionMs) {
          delete candidate[key];
          count += 1;
        }
      }
      if (count > 0 && saveAll(candidate)) records = candidate;
      return count;
    },
  };
}
