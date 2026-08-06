import { childConvoId as deriveChildConvoId } from './subagent-convos.js';

// Pure reconciliation core for stranded `running` subagent child convos.
// Given the persisted running-child records (from
// subagent-running-store.list()) and the set of parent convo ids currently
// owned by a LIVE session, decide which children are ghosts.
//
// TERMINAL-PARENT is the safe signal: a running child is a ghost only when NO
// live session owns its parent convo — the parent's claude process died with
// the old bridge (restart), or the parent stream was lost. A child under a
// still-live coordinator parent is LEFT running: a coordinator legitimately
// stays running for a long time, so its subagents must not be retired (a bare
// idle-TTL sweep — the rejected Option B — would do exactly that). This is a
// pure predicate so it is unit-testable without a socket, a filesystem, or a
// live bridge.
//
// Returns { stranded, malformed }:
//   - stranded: child convo ids whose parent is VALIDATED terminal → mark done.
//   - malformed: records without complete, SELF-CONSISTENT provenance. FAIL-
//     CLOSED: a terminal mutation is published against the parent
//     convo the reconciliation decision was made on, so the record's parentConvoId
//     must be present AND the childConvoId must equal its canonical derivation
//     childConvoId(parentConvoId, agentId). A record whose childConvoId encodes a
//     different parent than its parentConvoId field (schema drift / semantic
//     corruption) could otherwise mark an actually-live child `done` in every
//     client. Such records are surfaced for the caller to log/quarantine, never
//     terminally mutated. In normal operation add() only ever writes canonical,
//     agentId-bearing records, so `malformed` stays empty.
export function selectStrandedChildren(entries, liveParentConvoIds) {
  const live = liveParentConvoIds instanceof Set
    ? liveParentConvoIds
    : new Set(liveParentConvoIds || []);
  const stranded = [];
  const malformed = [];
  for (const entry of entries || []) {
    if (!entry || typeof entry.childConvoId !== 'string' || !entry.childConvoId) continue;
    const { childConvoId: cid, parentConvoId, agentId } = entry;
    const provenanceValid = typeof parentConvoId === 'string' && parentConvoId
      && typeof agentId === 'string' && agentId
      && deriveChildConvoId(parentConvoId, agentId) === cid;
    if (!provenanceValid) {
      malformed.push(cid);
      continue;
    }
    // Parent still owned by a live session → genuinely running, leave it.
    if (live.has(parentConvoId)) continue;
    stranded.push(cid);
  }
  return { stranded, malformed };
}
