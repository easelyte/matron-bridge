import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createKeyedRecordStore } from './keyed-record-store.js';

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
  // The four-state read discipline and atomic write live in keyed-record-store.js, shared with
  // run-state-outbox.js. The semantics below (idempotent add, no-op remove, refuse on unreadable)
  // are unchanged; only the duplicated file handling moved out.
  const store = createKeyedRecordStore({ file, label: 'subagent-running-store', log });

  return {
    // Record a child minted `running`. Idempotent: a re-mint of the same childConvoId keeps the
    // original addedAt rather than resetting it. Returns true only on a durable write (or an
    // idempotent no-op on an already-present record); false when the state is unreadable or the
    // write failed (F2).
    add(childConvoId, { parentConvoId, agentId } = {}) {
      if (typeof childConvoId !== 'string' || !childConvoId) return false;
      if (typeof parentConvoId !== 'string' || !parentConvoId) return false;
      return store.mutate((data) => {
        if (data[childConvoId]) return false; // already recorded — idempotent
        data[childConvoId] = {
          parentConvoId,
          agentId: typeof agentId === 'string' && agentId ? agentId : null,
          addedAt: Date.now(),
        };
      });
    },

    // Drop a child that reached `done` (live finish, teardown finishAll, or reconciliation).
    // Returns true on a durable write / no-op; false when the state is unreadable or the write
    // failed. No-op when absent.
    remove(childConvoId) {
      if (typeof childConvoId !== 'string' || !childConvoId) return false;
      return store.mutate((data) => {
        if (!(childConvoId in data)) return false;
        delete data[childConvoId];
      });
    },

    // The "list running children" accessor: every persisted running child as
    // { childConvoId, parentConvoId, agentId, addedAt }. This is what reconciliation reads — the
    // answer never depends on re-discovering the (now "seen") agent-*.jsonl transcripts.
    list() {
      return store.entries().map(([childConvoId, rec]) => ({
        childConvoId,
        parentConvoId: rec?.parentConvoId ?? null,
        agentId: rec?.agentId ?? null,
        addedAt: rec?.addedAt ?? null,
      }));
    },
  };
}
