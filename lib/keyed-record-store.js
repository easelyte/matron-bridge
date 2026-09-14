import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

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

  // tmp + atomic rename: a crash mid-write cannot leave a truncated JSON file that would then
  // read as empty and silently forget every record. The tmp gets an unpredictable suffix and is
  // created O_EXCL 0600 ('wx') so it cannot be pre-created or symlinked between open and write.
  function saveAll(data) {
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      // A failed rename can leave the uniquely-named tmp behind; drop it so retries do not accrete.
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
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
