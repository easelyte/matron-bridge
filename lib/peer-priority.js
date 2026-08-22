// Loop #688 (peer-message priority-interrupt tier v2) — CONSUMER half.
//
// The PRODUCER half (bridge PR #38) added an optional `priority` flag to
// agent_message and carries it on the peer_message wire payload. This module
// is the pure decision layer for how a receiving session REACTS to an inbound
// priority peer-message: whether it preempts the turn currently running.
//
// Operator-approved precedence, highest to lowest:
//   operator > peer-priority > peer-coalesced > autonomous
//
// A priority peer-message that arrives MID-TURN (session busy) preempts the
// running turn ONLY IF it strictly outranks whatever is currently running. So
// a peer-priority message never preempts an in-flight operator turn (operator
// outranks it) and never preempts another peer-priority turn (equal tier), but
// it does preempt a running peer-coalesced or autonomous turn. At a LIVE PROMPT
// (idle, waiting at the composer — not mid-turn) there is nothing to preempt:
// the message defers and injects normally, exactly like a non-priority peer.

export const TURN_TIER = Object.freeze({
  OPERATOR: 'operator',
  PEER_PRIORITY: 'peer-priority',
  PEER_COALESCED: 'peer-coalesced',
  AUTONOMOUS: 'autonomous',
});

// Higher number = higher precedence. The gap sizes are irrelevant; only the
// strict ordering is load-bearing.
export const TIER_RANK = Object.freeze({
  [TURN_TIER.OPERATOR]: 3,
  [TURN_TIER.PEER_PRIORITY]: 2,
  [TURN_TIER.PEER_COALESCED]: 1,
  [TURN_TIER.AUTONOMOUS]: 0,
});

// Rank of a running turn's tier. An unknown/undefined/null tier is deliberately
// treated as OPERATOR rank — the safe maximum. A turn we cannot classify is
// protected exactly like an operator turn and is never preempted; the feature
// only fires against turns we have positively tagged as a lower tier (a peer
// injection, or an explicitly autonomous source). This keeps the safety-critical
// invariant "a priority peer never interrupts an operator turn" total, even if a
// turn-start path forgets to tag its tier.
export function tierRank(tier) {
  return Object.prototype.hasOwnProperty.call(TIER_RANK, tier)
    ? TIER_RANK[tier]
    : TIER_RANK[TURN_TIER.OPERATOR];
}

// The tier of a peer turn about to be injected, given the batch of peer messages
// it carries. A batch containing ANY priority message is a peer-priority turn;
// otherwise it is peer-coalesced. Only priority === true counts (never a truthy
// coincidence), matching the producer's strict flag semantics.
export function peerBatchTier(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.some(message => message?.priority === true)
    ? TURN_TIER.PEER_PRIORITY
    : TURN_TIER.PEER_COALESCED;
}

// The consumer-half decision: should an inbound priority peer-message preempt
// the turn currently running?
//   - Only a priority peer (priority === true) ever preempts.
//   - Only while MID-TURN (busy === true). At a live prompt the message defers
//     and injects normally — there is no running turn to interrupt.
//   - And only if peer-priority STRICTLY outranks the running turn's tier, so an
//     operator turn (higher) and another peer-priority turn (equal) are never
//     preempted, while a peer-coalesced or autonomous turn (lower) is.
export function shouldPreemptForPriorityPeer({ priority, busy, runningTier } = {}) {
  if (priority !== true) return false;
  if (busy !== true) return false;
  return TIER_RANK[TURN_TIER.PEER_PRIORITY] > tierRank(runningTier);
}
