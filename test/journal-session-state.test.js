import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSessionStateLatch } from '../lib/journal-session-state.js';

// Harness: `publish` stands in for index.js's journalUpsertConvo and records
// every offer with its onEvicted hook, so a test can "evict" a chosen frame
// exactly the way lib/journal-publisher.js does (hook called with the frame).
function harness({ sessions = new Map() } = {}) {
  const offers = [];
  const direct = [];
  const latch = createSessionStateLatch({
    publish: (session, state, options) => {
      offers.push({ session, state, options });
    },
    upsertConvoDirect: (convoId, state, options) => {
      direct.push({ convoId, state, options });
    },
    resolveSession: (convoId) => sessions.get(convoId) || null,
    warn: () => {},
  });
  const evict = (offer, convoId) => offer.options.onEvicted({
    op: 'convo_upsert', convo_id: convoId, session_state: offer.state,
  });
  return { latch, offers, direct, evict, sessions };
}

describe('createSessionStateLatch', () => {
  it('publishes a state once and suppresses the same state until it changes', () => {
    const { latch, offers } = harness();
    const session = {};
    expect(latch.offer(session, 'running')).toBe(true);
    expect(latch.offer(session, 'running')).toBe(false);
    expect(latch.offer(session, 'waiting')).toBe(true);
    expect(offers.map(o => o.state)).toEqual(['running', 'waiting']);
    expect(typeof offers[0].options.onEvicted).toBe('function');
  });

  it('publish -> evicted -> the same state publishes again instead of being latched as sent', () => {
    const { latch, offers, evict, sessions } = harness();
    const session = {};
    sessions.set('c1', session);
    latch.offer(session, 'running');
    expect(latch.offer(session, 'running')).toBe(false);

    evict(offers[0], 'c1');

    expect(latch.offer(session, 'running')).toBe(true);
    expect(offers.map(o => o.state)).toEqual(['running', 'running']);
  });

  it('re-offers the evicted state for a live session once the publisher has capacity', () => {
    const { latch, offers, evict, sessions } = harness();
    const session = {};
    sessions.set('c1', session);
    latch.offer(session, 'running');
    evict(offers[0], 'c1');
    expect(offers).toHaveLength(1); // no re-offer while the queue is still full

    expect(latch.onCapacity()).toBe(true);
    expect(offers).toHaveLength(2);
    expect(offers[1]).toMatchObject({ session, state: 'running' });
    expect(typeof offers[1].options.onEvicted).toBe('function'); // a re-offer can be evicted too
    expect(latch.onCapacity()).toBe(false); // nothing left pending
    expect(offers).toHaveLength(2);
  });

  it('does not re-offer a stale state when a newer one was published after the eviction', () => {
    const { latch, offers, evict, sessions } = harness();
    const session = {};
    sessions.set('c1', session);
    latch.offer(session, 'running');
    evict(offers[0], 'c1');
    latch.offer(session, 'waiting'); // newer state went out after the latch was released

    expect(latch.onCapacity()).toBe(false);
    expect(offers.map(o => o.state)).toEqual(['running', 'waiting']);
  });

  it('leaves the latch alone when the evicted frame carried an older state than the current one', () => {
    const { latch, offers, evict } = harness();
    const session = {};
    latch.offer(session, 'running');
    latch.offer(session, 'waiting');
    evict(offers[0], 'c1'); // the stale 'running' frame is what fell off the queue
    expect(latch.offer(session, 'waiting')).toBe(false); // 'waiting' is still legitimately queued
  });

  it('re-offers done directly when the session is gone, so the row does not stay running', () => {
    const { latch, offers, direct, evict, sessions } = harness();
    const session = {};
    sessions.set('c1', session);
    latch.offer(session, 'running');
    evict(offers[0], 'c1');
    sessions.delete('c1'); // session exited during the outage

    expect(latch.onCapacity()).toBe(true);
    expect(offers).toHaveLength(1);
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({ convoId: 'c1', state: 'done' });

    // The direct re-offer can be evicted as well: it re-arms and retries.
    direct[0].options.onEvicted({ op: 'convo_upsert', convo_id: 'c1', session_state: 'done' });
    expect(latch.onCapacity()).toBe(true);
    expect(direct).toHaveLength(2);
  });

  it('re-offers one convo per capacity tick (headroom is only guaranteed for one frame)', () => {
    const { latch, offers, evict, sessions } = harness();
    const a = {}; const b = {};
    sessions.set('a', a); sessions.set('b', b);
    latch.offer(a, 'running');
    latch.offer(b, 'waiting');
    evict(offers[0], 'a');
    evict(offers[1], 'b');

    expect(latch.onCapacity()).toBe(true);
    expect(offers).toHaveLength(3);
    expect(latch.onCapacity()).toBe(true);
    expect(offers).toHaveLength(4);
    expect(offers.slice(2).map(o => [o.session, o.state])).toEqual([[a, 'running'], [b, 'waiting']]);
    expect(latch.onCapacity()).toBe(false);
  });

  it('releases the latch on the live session object even if the frame came from a replaced one', () => {
    // index.js restarts copy _journalState onto the replacement session and
    // keep the convo id, so the eviction must act on whichever object is live.
    const { latch, offers, evict, sessions } = harness();
    const old = {};
    sessions.set('c1', old);
    latch.offer(old, 'running');
    const replacement = { _journalState: old._journalState };
    sessions.set('c1', replacement);

    evict(offers[0], 'c1');
    expect(latch.offer(replacement, 'running')).toBe(true);
  });

  it('ignores frames without a convo or state and a throwing publish', () => {
    const publish = vi.fn(() => { throw new Error('nope'); });
    const warn = vi.fn();
    const latch = createSessionStateLatch({ publish, upsertConvoDirect: () => {}, resolveSession: () => null, warn });
    const session = {};
    expect(() => latch.offer(session, 'running')).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(() => publish.mock.calls[0][2].onEvicted({ op: 'convo_upsert' })).not.toThrow();
    expect(latch.onCapacity()).toBe(false);
  });
});

// The wiring can only be verified by source inspection, as the other *-wiring
// tests do: journalSessionState must delegate to the latch and the publisher's
// capacity hook must drive the re-offer.
describe('index.js session-state latch wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

  it('journalSessionState delegates to the latch instead of latching on session._journalState itself', () => {
    const start = src.indexOf('function journalSessionState(session, state) {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/sessionStateLatch\.offer\(session, state\)/);
    expect(body).not.toMatch(/session\._journalState = state/);
  });

  it('chains the latch re-offer onto the publisher onSendCapacity hook', () => {
    const start = src.indexOf('onSendCapacity:');
    expect(start).toBeGreaterThan(-1);
    const line = src.slice(start, src.indexOf('\n', start));
    expect(line).toMatch(/republishPendingReleases\(\)/);
    expect(line).toMatch(/sessionStateLatch\.onCapacity\(\)/);
  });

  it('threads publish options (onEvicted) through journalPublish, the pre-id buffer and its flush', () => {
    expect(src).toMatch(/function journalPublish\(session, method, payload, options\)/);
    expect(src).toMatch(/journalPublisher\[method\]\(convoId, payload, options\)/);
    expect(src).toMatch(/function journalBufferPush\(session, method, payload, options\)/);
    expect(src).toMatch(/for \(const \{ method, payload, options \} of buffered\)/);
  });
});
