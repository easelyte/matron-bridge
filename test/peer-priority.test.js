import { describe, it, expect } from 'vitest';
import {
  TURN_TIER,
  TIER_RANK,
  tierRank,
  peerBatchTier,
  roomBatchTier,
  shouldPreemptForPriorityPeer,
} from '../lib/peer-priority.js';

// Loop #688 consumer half: the precedence gate that decides whether an inbound
// priority peer-message preempts the running turn. Operator-approved precedence,
// highest to lowest: operator > peer-priority > peer-coalesced > autonomous.

describe('turn-tier precedence', () => {
  it('ranks the four tiers strictly operator > peer-priority > peer-coalesced > autonomous', () => {
    expect(TIER_RANK[TURN_TIER.OPERATOR]).toBeGreaterThan(TIER_RANK[TURN_TIER.PEER_PRIORITY]);
    expect(TIER_RANK[TURN_TIER.PEER_PRIORITY]).toBeGreaterThan(TIER_RANK[TURN_TIER.PEER_COALESCED]);
    expect(TIER_RANK[TURN_TIER.PEER_COALESCED]).toBeGreaterThan(TIER_RANK[TURN_TIER.AUTONOMOUS]);
  });

  it('names the four tiers with their wire strings', () => {
    expect(TURN_TIER).toEqual({
      OPERATOR: 'operator',
      PEER_PRIORITY: 'peer-priority',
      PEER_COALESCED: 'peer-coalesced',
      AUTONOMOUS: 'autonomous',
    });
  });
});

describe('tierRank', () => {
  it('returns the rank for each known tier', () => {
    expect(tierRank('operator')).toBe(TIER_RANK.operator);
    expect(tierRank('peer-priority')).toBe(TIER_RANK['peer-priority']);
    expect(tierRank('peer-coalesced')).toBe(TIER_RANK['peer-coalesced']);
    expect(tierRank('autonomous')).toBe(TIER_RANK.autonomous);
  });

  it('treats an unknown/undefined/null running tier as operator-rank (safe max: never preemptable)', () => {
    // A running turn we cannot classify must be protected exactly like an
    // operator turn — an unclassified turn is never assumed to be autonomous.
    expect(tierRank(undefined)).toBe(TIER_RANK.operator);
    expect(tierRank(null)).toBe(TIER_RANK.operator);
    expect(tierRank('nonsense')).toBe(TIER_RANK.operator);
  });
});

describe('peerBatchTier', () => {
  it('is peer-priority when any message in the batch is priority, else peer-coalesced', () => {
    expect(peerBatchTier([{ priority: false }, { priority: true }])).toBe('peer-priority');
    expect(peerBatchTier([{ priority: true }])).toBe('peer-priority');
    expect(peerBatchTier([{ priority: false }, {}])).toBe('peer-coalesced');
    expect(peerBatchTier([{}])).toBe('peer-coalesced');
  });

  it('only treats priority === true as priority (never a truthy coincidence)', () => {
    expect(peerBatchTier([{ priority: 1 }])).toBe('peer-coalesced');
    expect(peerBatchTier([{ priority: 'true' }])).toBe('peer-coalesced');
  });

  it('defaults an empty/absent batch to peer-coalesced', () => {
    expect(peerBatchTier([])).toBe('peer-coalesced');
    expect(peerBatchTier(undefined)).toBe('peer-coalesced');
  });
});

describe('roomBatchTier', () => {
  it('is peer-coalesced for a purely agent-origin room batch (preemptable coordinating turn)', () => {
    expect(roomBatchTier([{ fromAgent: true }])).toBe('peer-coalesced');
    expect(roomBatchTier([{ fromAgent: true }, { fromAgent: true }])).toBe('peer-coalesced');
  });

  it('is operator-protected (null) when any message is operator-origin', () => {
    // The operator typing into a room must never be preemptable — one operator
    // message in the batch protects the whole turn.
    expect(roomBatchTier([{ fromAgent: false }])).toBeNull();
    expect(roomBatchTier([{ fromAgent: true }, { fromAgent: false }])).toBeNull();
    expect(roomBatchTier([{}])).toBeNull();
  });

  it('is operator-protected (null) for an empty/absent batch', () => {
    expect(roomBatchTier([])).toBeNull();
    expect(roomBatchTier(undefined)).toBeNull();
  });

  it('only treats fromAgent === true as agent-origin', () => {
    expect(roomBatchTier([{ fromAgent: 1 }])).toBeNull();
    expect(roomBatchTier([{ fromAgent: 'true' }])).toBeNull();
  });

  it('a peer-coalesced room turn is outranked by a priority peer (end-to-end precedence)', () => {
    const runningTier = roomBatchTier([{ fromAgent: true }]);
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier })).toBe(true);
  });

  it('an operator room turn is NOT preempted by a priority peer', () => {
    const runningTier = roomBatchTier([{ fromAgent: false }]);
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier })).toBe(false);
  });
});

describe('roomBatchTier — explicit per-message tier + coalescing precedence (loop #688 seam-tiering, R3 F2)', () => {
  // The room-delivery inbox is a SINGLE per-session inbox that coalesces every
  // room-flavoured injection — real peer room frames, invite/join requests,
  // room-lifecycle FYIs, and spawn outcomes — into one turn. Seams that are not
  // ordinary peer frames tag their message with an explicit `tier` so the
  // classifier can place the coalesced turn correctly by provenance while the
  // batch still adopts its MOST-PROTECTED member.
  it('honors an explicit autonomous tier (spawn-outcome turn)', () => {
    expect(roomBatchTier([{ tier: 'autonomous' }])).toBe('autonomous');
  });

  it('honors an explicit peer-coalesced tier (invite / room-lifecycle turn)', () => {
    expect(roomBatchTier([{ tier: 'peer-coalesced' }])).toBe('peer-coalesced');
  });

  it('adopts the most-protected member: any operator message protects the whole coalesced turn', () => {
    // A spawn outcome or invite that coalesces with a real operator (user:)
    // room frame must NOT become preemptable — the operator content wins.
    expect(roomBatchTier([{ tier: 'autonomous' }, { fromAgent: false }])).toBeNull();
    expect(roomBatchTier([{ tier: 'peer-coalesced' }, {}])).toBeNull();
    expect(roomBatchTier([{ fromAgent: true }, { tier: 'autonomous' }, {}])).toBeNull();
  });

  it('a mix of autonomous and peer-coalesced takes the higher, more-protected tier (peer-coalesced)', () => {
    expect(roomBatchTier([{ tier: 'autonomous' }, { fromAgent: true }])).toBe('peer-coalesced');
    expect(roomBatchTier([{ tier: 'autonomous' }, { tier: 'peer-coalesced' }])).toBe('peer-coalesced');
  });

  it('falls back to fromAgent provenance when no explicit tier is set (unchanged legacy behavior)', () => {
    expect(roomBatchTier([{ fromAgent: true }])).toBe('peer-coalesced');
    expect(roomBatchTier([{ fromAgent: false }])).toBeNull();
    expect(roomBatchTier([{}])).toBeNull();
  });

  it('ignores an unknown/garbage explicit tier and falls back to provenance (safe default)', () => {
    expect(roomBatchTier([{ tier: 'nonsense', fromAgent: true }])).toBe('peer-coalesced');
    expect(roomBatchTier([{ tier: 'nonsense' }])).toBeNull();
    expect(roomBatchTier([{ tier: 'nonsense', fromAgent: false }])).toBeNull();
    // Only the string wire values are honored — a truthy non-string never tiers.
    expect(roomBatchTier([{ tier: 1 }])).toBeNull();
  });

  it('operator provenance is DOMINANT: an explicit lower tier can never downgrade a fromAgent:false operator frame (Codex F1)', () => {
    // A contradictory { fromAgent: false, tier: <lower> } shape must stay
    // operator-protected — the classifier enforces the invariant, not producer
    // discipline. No producer builds this shape today; this pins it total.
    expect(roomBatchTier([{ fromAgent: false, tier: 'autonomous' }])).toBeNull();
    expect(roomBatchTier([{ fromAgent: false, tier: 'peer-coalesced' }])).toBeNull();
    expect(
      shouldPreemptForPriorityPeer({
        priority: true,
        busy: true,
        runningTier: roomBatchTier([{ fromAgent: false, tier: 'autonomous' }]),
      }),
    ).toBe(false);
  });

  it('an autonomous spawn-outcome turn is preempted by a priority peer (end-to-end)', () => {
    const runningTier = roomBatchTier([{ tier: 'autonomous' }]);
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier })).toBe(true);
  });

  it('a peer-coalesced invite/lifecycle turn is preempted by a priority peer (end-to-end)', () => {
    const runningTier = roomBatchTier([{ tier: 'peer-coalesced' }]);
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier })).toBe(true);
  });

  it('an operator-protected coalesced turn (spawn/invite + operator mix) is NOT preempted', () => {
    const runningTier = roomBatchTier([{ tier: 'autonomous' }, { fromAgent: false }]);
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier })).toBe(false);
  });
});

describe('shouldPreemptForPriorityPeer', () => {
  // A priority peer preempts the running turn ONLY IF it strictly outranks it.
  it('preempts a running autonomous turn', () => {
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier: 'autonomous' })).toBe(true);
  });

  it('preempts a running peer-coalesced (normal-peer) turn', () => {
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier: 'peer-coalesced' })).toBe(true);
  });

  it('does NOT preempt a running peer-priority turn (equal tier does not preempt)', () => {
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier: 'peer-priority' })).toBe(false);
  });

  it('does NOT preempt an in-flight OPERATOR turn (operator outranks peer-priority)', () => {
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier: 'operator' })).toBe(false);
  });

  it('does NOT preempt an unclassified running turn (unknown tier is treated as operator)', () => {
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier: undefined })).toBe(false);
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: true, runningTier: null })).toBe(false);
  });

  it('does NOT preempt at a live prompt (idle / not mid-turn): defer, inject normally', () => {
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: false, runningTier: 'autonomous' })).toBe(false);
    expect(shouldPreemptForPriorityPeer({ priority: true, busy: false, runningTier: 'peer-coalesced' })).toBe(false);
  });

  it('never preempts for a non-priority peer, whatever the running tier', () => {
    expect(shouldPreemptForPriorityPeer({ priority: false, busy: true, runningTier: 'autonomous' })).toBe(false);
    expect(shouldPreemptForPriorityPeer({ priority: false, busy: true, runningTier: 'peer-coalesced' })).toBe(false);
    expect(shouldPreemptForPriorityPeer({ priority: undefined, busy: true, runningTier: 'autonomous' })).toBe(false);
  });

  it('only treats priority === true as priority (a truthy non-true never preempts)', () => {
    expect(shouldPreemptForPriorityPeer({ priority: 1, busy: true, runningTier: 'autonomous' })).toBe(false);
    expect(shouldPreemptForPriorityPeer({ priority: 'true', busy: true, runningTier: 'autonomous' })).toBe(false);
  });
});
