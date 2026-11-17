import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildRestartStatus } from '../lib/box-status-restart.js';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const publish = index.slice(index.indexOf('function publishBoxStatus('), index.indexOf('const journalPublisher ='));

describe('restart box status wiring', () => {
  it.each(['sent', 'disconnected', 'exception'])('returns the publisher outcome for %s without interrupting state changes', outcome => {
    const calls = [];
    const seam = index.slice(index.indexOf('export function publishRestartStatus('),
      index.indexOf('\n// A box_status carrying only `vitals`', index.indexOf('export function publishRestartStatus(')));
    const publishRestartStatus = runInNewContext(seam.replace('export ', '') + '\npublishRestartStatus', {
      publishBoxStatus: reason => {
        calls.push(reason);
        if (outcome === 'exception') throw new Error('unavailable publisher');
        return outcome === 'sent';
      },
    });
    expect(publishRestartStatus('pending')).toBe(outcome === 'sent');
    expect(calls).toEqual(['restart pending']);
  });

  it('publishes the layer\'s state and its last verdict through the production publisher, alone', () => {
    const frames = [];
    const state = { id: 'restart-a', state: 'pending', requests: [{ reason: 'update', sha: 'abc', request_key: 'alice' }], pending_since: 100, expected_sha: null };
    const verdict = { waiting_on: { quiet: { holders: [], probe_error: null }, code: null, preflight: null, collect: null, unwarned: [] } };
    const publishBoxStatus = runInNewContext(publish.replace('export ', '') + '\npublishBoxStatus', {
      boxLock: null, JOURNAL_ENABLED: true, restartRequests: { getState: () => state, lastVerdict: verdict }, buildRestartStatus,
      sessions: new Map(), loadPersistedSessions: () => [], buildActivity: () => null,
      usageLimitsCache: null, codexLimits: { cache: null }, boxVitals: () => null, pluginsReport: () => ({}), buildLimits: () => null, DEFAULT_WORKDIR: '.', buildDisk: () => null,
      getAccountEmail: () => null, defaultAgentInfo: () => { throw new Error('unavailable'); },
      worktreeCleanup: { summary: () => null },
      journalPublisher: { sendRoomOp: frame => { frames.push(JSON.parse(JSON.stringify(frame))); return true; } },
      debug: () => {},
    });
    expect(publishBoxStatus('test')).toBe(true);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ op: 'box_status', restart: buildRestartStatus(state, verdict) });
    expect(frames[0].restart).toMatchObject({ id: 'restart-a', state: 'pending', requests: [{ sha: 'abc', reason: 'update' }] });
  });

  it('builds restart status from the layer\'s durable state and last verdict, and sends it alone', () => {
    expect(publish).toContain('buildRestartStatus(restartRequests.getState(), restartRequests.lastVerdict)');
    expect(publish).toContain('&& !restart) return false;');
    expect(publish).toContain('...(restart ? { restart } : {}),');
  });

  it('exports a synchronous publish seam, called when the request changes and while it is pending', () => {
    expect(index).toMatch(/export function publishRestartStatus\(reason\)/);
    expect(index).toMatch(/onChange: \(\) => publishRestartStatus\('request'\),/);
    expect(index).toMatch(/restartRequests\.evaluate\(\);\s*publishRestartStatus\('gate'\);/);
    expect(index).toMatch(/else if \(wasPending\) publishRestartStatus\('cleared'\);/);
  });
});
