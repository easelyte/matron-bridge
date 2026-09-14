import fs from 'node:fs';

import { atomicWriteFileSync } from './atomic-write.js';

// Shared core for the bridge's small on-disk record stores: a flat JSON object of
// key -> record, persisted atomically, with the four-state read discipline these stores need to
// avoid destroying recovery evidence.
//
// Extracted from subagent-running-store.js when a second store (run-state-outbox.js) needed the
// identical handling. The subtlety here is not the JSON; it is the failure states, and having two
// hand-copied versions of them means a fix to one silently leaves the other broken.
//
// READ STATES:
//   - 'empty'      no file yet (normal first boot / clean teardown) -> safe to write
//   - 'ok'         parsed record map                                -> safe to write
//   - 'corrupt'    unparseable; QUARANTINED aside so the evidence survives and the path is free
//   - 'unreadable' present but unreadable (EACCES/EIO) -> mutations MUST refuse, since writing
//                  would permanently erase records we merely could not read
export function createKeyedRecordStore({ file, label, log = console } = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  function readState() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { status: 'empty', data: {} };
      warn(`[${label}] unreadable state file (${e?.code || e?.message}) — prior records not reconciled this boot; refusing to overwrite`);
      return { status: 'unreadable', data: {} };
    }
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) return { status: 'ok', data };
      throw new Error('state file is not a JSON object');
    } catch (e) {
      // Corrupt content must NOT masquerade as empty and get overwritten from {} — that would
      // destroy the recovery evidence. Quarantine it aside so a fresh store starts clean.
      const quarantine = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, quarantine);
        warn(`[${label}] corrupt state file (${e.message}) — quarantined to ${quarantine}; prior records not reconciled this boot`);
      } catch (renameErr) {
        warn(`[${label}] corrupt state file (${e.message}) and quarantine failed (${renameErr.message}) — prior records not reconciled this boot`);
        // The corrupt file is still in place; treat as unreadable so mutations refuse.
        return { status: 'unreadable', data: {} };
      }
      return { status: 'corrupt', data: {} };
    }
  }

  // Delegated to the canonical helper rather than hand-rolled: it carries the DURABILITY BARRIER
  // (fsync through the write's own descriptor before the rename). A plain writeFileSync +
  // renameSync only lands bytes in the page cache, so a host crash after the rename can surface
  // the target as zero-length or partial — the rename metadata reaches disk while the contents do
  // not. That is the classic rename-without-fsync loss, and it would defeat restart recovery at
  // exactly the moment these stores exist for. mode 0600 is applied to the temp so the rename
  // carries it onto the target, never leaving a world-readable instant.
  function saveAll(data) {
    try {
      atomicWriteFileSync(file, JSON.stringify(data), { mode: 0o600 });
      return true;
    } catch (e) {
      warn(`[${label}] save failed: ${e.message}`);
      return false;
    }
  }

  return {
    readState,
    saveAll,
    // Read, apply `fn(data)`, persist. `fn` returns false to abort without writing (an idempotent
    // no-op). Refuses outright when the file is present but unreadable.
    mutate(fn) {
      const { status, data } = readState();
      if (status === 'unreadable') return false;
      const outcome = fn(data);
      if (outcome === false) return true; // nothing to do — treat as a successful no-op
      return saveAll(data);
    },
    entries() {
      const { data } = readState();
      return Object.entries(data);
    },
  };
}
