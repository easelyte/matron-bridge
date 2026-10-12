import { describe, expect, it } from 'vitest';
import { buildRestartStatus } from '../lib/box-status-restart.js';

const waiting_on = { quiet: { holders: [{ convoId: 'alice', why: 'busy' }], probe_error: null },
  code: 'dirty tree', preflight: { unknown: true }, collect: { remaining_ms: 100 }, unwarned: ['bob'] };
const snapshot = state => ({ id: 'restart-a', state, requests: [{ sha: 'abc', reason: 'update', request_key: 'private' }],
  pending_since: 100, expected_sha: 'def', results: { resumed: 1 }, notified: { alice: 100 } });

describe('restart box status', () => {
  it.each(['pending', 'restarting', 'back', 'cancelled', 'abandoned'])('retains the persisted %s payload and last gate verdict', state => {
    expect(buildRestartStatus(snapshot(state), { waiting_on })).toEqual({ id: 'restart-a', state,
      requests: [{ sha: 'abc', reason: 'update' }], pending_since: 100, waiting_on,
      expected_sha: 'def', results: { resumed: 1 } });
  });

  it.each([null, undefined, {}, { id: null, state: null, requests: [] }])('omits status without a restart %j', state => {
    expect(buildRestartStatus(state)).toBeNull();
  });

  it('reports an unavailable gate without suggesting readiness and omits absent results', () => {
    const state = { ...snapshot('pending'), expected_sha: null };
    delete state.results;
    expect(buildRestartStatus(state)).toEqual({ id: 'restart-a', state: 'pending',
      requests: [{ sha: 'abc', reason: 'update' }], pending_since: 100, expected_sha: null,
      waiting_on: { quiet: { holders: [], probe_error: 'restart gate unavailable' },
        code: null, preflight: { unknown: true }, collect: null, unwarned: [] } });
  });

  it.each([20, 21])('caps request count at the boundary for %i requests', count => {
    const state = { ...snapshot('pending'), requests: Array.from({ length: count }, (_, i) => ({ reason: String(i) })) };
    const result = buildRestartStatus(state, { waiting_on });
    expect(result.requests).toEqual(state.requests.slice(0, 20).map(r => ({ sha: null, reason: r.reason })));
  });

  it.each([80, 81])('caps sha length at the boundary for %i characters', length => {
    const state = { ...snapshot('pending'), requests: [{ sha: 'a'.repeat(length), reason: 'update' }] };
    expect(buildRestartStatus(state).requests).toEqual([{ sha: 'a'.repeat(Math.min(length, 80)), reason: 'update' }]);
  });

  it.each([200, 201])('caps reason length at the boundary for %i characters', length => {
    const state = { ...snapshot('pending'), requests: [{ reason: 'a'.repeat(length) }] };
    expect(buildRestartStatus(state).requests).toEqual([{ sha: null, reason: 'a'.repeat(Math.min(length, 200)) }]);
  });

  it('bounds holders, unwarned sessions and results at the count boundary', () => {
    for (const count of [20, 21]) {
      const entries = Array.from({ length: count }, () => 'alice');
      const holders = entries.map(convoId => ({ convoId, why: 'busy' }));
      const result = buildRestartStatus({ ...snapshot('back'), results: entries }, {
        waiting_on: { ...waiting_on, quiet: { holders, probe_error: null }, unwarned: entries },
      });
      expect(result.waiting_on.quiet.holders).toEqual(holders.slice(0, 20));
      expect(result.waiting_on.unwarned).toEqual(entries.slice(0, 20));
      expect(result.results).toEqual(entries.slice(0, 20));
      expect(result.truncated).toEqual(count > 20 ? { holders: 1, unwarned: 1, results: 1 } : undefined);
    }
  });

  it('bounds every public string at its length boundary', () => {
    for (const length of [200, 201]) {
      const value = 'a'.repeat(length);
      const result = buildRestartStatus({ ...snapshot('back'), id: value, expected_sha: value,
        results: [{ error: value }] }, { waiting_on: { ...waiting_on, code: value,
        quiet: { holders: [{ convoId: value, why: value }], probe_error: value },
        preflight: { error: value }, unwarned: [value] } });
      const capped = value.slice(0, 200);
      expect(result.id).toBe(capped);
      expect(result.expected_sha).toBe(value.slice(0, 80));
      expect(result.waiting_on.code).toBe(capped);
      expect(result.waiting_on.quiet).toEqual({ holders: [{ convoId: capped, why: capped }], probe_error: capped });
      expect(result.waiting_on.preflight).toEqual({ error: 'preflight failed' });
      expect(result.waiting_on.unwarned).toEqual([capped]);
      expect(result.results).toEqual([{ error: capped }]);
    }
  });

  it('bounds nested result collections and reports omitted entries', () => {
    const entries = Array.from({ length: 21 }, (_, i) => [String(i), 'alice']);
    const result = buildRestartStatus({ ...snapshot('back'), results: { resumed: Object.fromEntries(entries),
      failed: entries.map(() => 'bob') } });
    expect(result.results.resumed).toEqual(Object.fromEntries(entries.slice(0, 20)));
    expect(result.results.failed).toHaveLength(20);
    expect(result.truncated.results).toBe(2);
  });

  it('caps the serialized payload while retaining hold indicators and durable state', () => {
    const text = '\u0001'.repeat(200);
    const entries = Array.from({ length: 20 }, () => text);
    const state = { ...snapshot('pending'), requests: entries.map(reason => ({ reason, sha: text })),
      results: entries.map(() => Object.fromEntries(entries.map((_, i) => [String(i), text]))) };
    const before = JSON.stringify(state);
    const result = buildRestartStatus(state, { waiting_on: { ...waiting_on,
      quiet: { holders: entries.map(convoId => ({ convoId, why: text })), probe_error: text },
      preflight: { error: text }, unwarned: entries } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
    expect(result.waiting_on.quiet.probe_error).toBe(text);
    expect(result.waiting_on.preflight).toEqual({ error: 'preflight failed' });
    expect(result.truncated.results).toBeGreaterThan(0);
    expect(JSON.stringify(state)).toBe(before);
  });

});
