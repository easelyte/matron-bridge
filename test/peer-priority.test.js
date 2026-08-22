import { describe, it, expect } from 'vitest';
import {
  TURN_TIER,
  TIER_RANK,
  tierRank,
  peerBatchTier,
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
