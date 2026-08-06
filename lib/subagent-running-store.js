import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Persistent record of subagent child conversations currently in the `running`
// state. The tracker's in-memory `children` Map is process-only, so
// a bridge restart / unclean parent teardown strands any child that never
// reached `done` through the live-stream finish paths (noteTaskResult /
// noteTaskCompleted / finishAll). subagent-watcher.snapshot() then marks the
// already-complete agent-*.jsonl "seen", so it is never re-discovered and
// finish() never fires — the child stays `running` forever on the server row and
// every client. This store survives restart so reconciliation can find those
// ghosts from PERSISTED state (never from watcher re-discovery, which can't
// re-find them). Keyed by the deterministic childConvoId, so a re-mint of the
// same child (same parent convo + agentId) is idempotent.
const DEFAULT_FILE = path.join(os.homedir(), '.claude-subagent-running.json');

export function createSubagentRunningStore({ file = DEFAULT_FILE, log = console } = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  // Read the store, distinguishing the four states so mutations can decide
  // whether writing is safe (F2/F4):
  //   - { status: 'empty' }      no file yet (normal first boot / clean teardown)
  //   - { status: 'ok', data }   parsed record map
  //   - { status: 'corrupt' }    parseable-file failure → quarantined here; the
  //                              original path is now free, so a fresh write is safe
  //   - { status: 'unreadable' } read failed (EACCES/EIO) with the file still
  //                              present → writing could ERASE unrecoverable
  //                              records, so mutations must refuse (F4)
  function readState() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { status: 'empty', data: {} };
      // File is present but unreadable — fail-visible, and callers must NOT
      // overwrite it (that would permanently erase the prior recovery records).
      warn(`[subagent-running-store] unreadable state file (${e?.code || e?.message}) — prior running children not reconciled this boot; refusing to overwrite`);
      return { status: 'unreadable', data: {} };
    }
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) return { status: 'ok', data };
      throw new Error('state file is not a JSON object');
    } catch (e) {
      // Corrupt content: DON'T let it masquerade as empty and get overwritten
      // from {} (which would destroy the recovery evidence — F3). Quarantine the
      // bad file (rename aside) so a fresh store starts clean while the evidence
      // is preserved for inspection, and surface it loudly.
      const quarantine = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, quarantine);
        warn(`[subagent-running-store] corrupt state file (${e.message}) — quarantined to ${quarantine}; prior running children not reconciled this boot`);
      } catch (renameErr) {
        warn(`[subagent-running-store] corrupt state file (${e.message}) and quarantine failed (${renameErr.message}) — prior running children not reconciled this boot`);
        // Quarantine failed → the corrupt file is still in place; treat as
        // unreadable so mutations refuse to overwrite it.
        return { status: 'unreadable', data: {} };
      }
      return { status: 'corrupt', data: {} };
    }
  }

  // Returns true on a durable write, false (with a warn) on failure — so callers
  // that must not silently create unrecoverable state can inspect the result (F2).
  function saveAll(data) {
    try {
      // tmp + atomic rename: a crash mid-write can't leave a truncated JSON
      // file that would then read as empty and silently forget every ghost.
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      warn(`[subagent-running-store] save failed: ${e.message}`);
      return false;
    }
  }

  return {
    // Record a child minted `running`. Idempotent: a re-mint of the same
    // childConvoId keeps the original addedAt rather than resetting it. Returns
    // true only on a durable write (or an idempotent no-op on an already-present
    // record); false when the state is unreadable or the write failed (F2).
    add(childConvoId, { parentConvoId, agentId } = {}) {
      if (typeof childConvoId !== 'string' || !childConvoId) return false;
      if (typeof parentConvoId !== 'string' || !parentConvoId) return false;
      const { status, data } = readState();
      // Never overwrite a present-but-unreadable file — that would erase records
      // we simply couldn't read (F4).
      if (status === 'unreadable') return false;
      if (data[childConvoId]) return true; // already recorded — idempotent
      data[childConvoId] = {
        parentConvoId,
        agentId: typeof agentId === 'string' && agentId ? agentId : null,
        addedAt: Date.now(),
      };
      return saveAll(data);
    },

    // Drop a child that reached `done` (live finish, teardown finishAll, or
    // reconciliation). Returns true on a durable write / no-op; false when the
    // state is unreadable or the write failed. No-op when absent.
    remove(childConvoId) {
      if (typeof childConvoId !== 'string' || !childConvoId) return false;
      const { status, data } = readState();
      if (status === 'unreadable') return false;
      if (!(childConvoId in data)) return true;
      delete data[childConvoId];
      return saveAll(data);
    },

    // The "list running children" accessor: every persisted running child as
    // { childConvoId, parentConvoId, agentId, addedAt }. This is what
    // reconciliation reads — the answer never depends on re-discovering the
    // (now "seen") agent-*.jsonl transcripts.
    list() {
      const { data } = readState();
      return Object.entries(data).map(([childConvoId, rec]) => ({
        childConvoId,
        parentConvoId: rec?.parentConvoId ?? null,
        agentId: rec?.agentId ?? null,
        addedAt: rec?.addedAt ?? null,
      }));
    },
  };
}
