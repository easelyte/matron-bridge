import { readFileSync } from 'node:fs';
import { buildRestartStatus } from '../lib/box-status-restart.js';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const publish = index.slice(index.indexOf('function publishBoxStatus('), index.indexOf('const journalPublisher ='));

// The box-status inputs index.js reads, stubbed to nothing.
const statusDeps = (frames, extra = {}) => ({
  boxLock: null, JOURNAL_ENABLED: true, buildRestartStatus,
  sessions: new Map(), loadPersistedSessions: () => [], buildActivity: () => null,
  usageLimitsCache: null, codexLimits: { cache: null }, boxVitals: () => null, pluginsReport: () => ({}), buildLimits: () => null,
  DEFAULT_WORKDIR: '.', buildDisk: () => null, getAccountEmail: () => null, worktreeCleanup: { summary: () => null },
  defaultAgentInfo: () => { throw new Error('unavailable'); },
  journalPublisher: { sendRoomOp: frame => { frames.push(JSON.parse(JSON.stringify(frame))); return true; } },
  debug: () => {}, ...extra,
});

describe('restart box status wiring', () => {
  it.each(['sent', 'disconnected', 'exception'])('returns the publisher outcome for %s without interrupting state changes', outcome => {
    const calls = [];
    const start = index.indexOf('export function publishRestartStatus(');
    const seam = index.slice(start, index.indexOf('\n// A box_status carrying only `vitals`', start));
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

  it('sends the guard state and its last verdict as the restart block, alone when nothing else is known', () => {
    const frames = [];
    const verdict = { waiting_on: { quiet: { holders: [{ convoId: 'alice', why: 'busy' }], probe_error: null },
      code: null, preflight: null, collect: null, unwarned: [] } };
    const state = { id: 'restart-a', state: 'pending', requests: [{ sha: 'abc', reason: 'update' }], pending_since: 100, notified: {} };
    const guard = { pending: () => true, getState: () => state, lastVerdict: verdict };
    runInNewContext(publish.replace('export ', '') + "\npublishBoxStatus('restart request');", statusDeps(frames, { restartGuard: guard }));
    expect(frames).toEqual([{ op: 'box_status', restart: buildRestartStatus(state, verdict) }]);
    expect(frames[0].restart.state).toBe('pending');
    expect(frames[0].restart.waiting_on.quiet.holders).toEqual([{ convoId: 'alice', why: 'busy' }]);
  });

  it('omits the restart block when no restart is requested', () => {
    const frames = [];
    const guard = { pending: () => false, getState: () => { throw new Error('not read'); }, lastVerdict: null };
    runInNewContext(publish.replace('export ', '') + "\npublishBoxStatus('heartbeat');", statusDeps(frames, { restartGuard: guard }));
    expect(frames).toEqual([]);
  });

  it('builds restart status from the guard, only while a request is pending, and sends it alone', () => {
    expect(publish).toContain('if (restartGuard?.pending()) restart = buildRestartStatus(restartGuard.getState(), restartGuard.lastVerdict);');
    expect(publish).toContain('&& !restart) return false;');
    expect(publish).toContain('...(restart ? { restart } : {}),');
  });

  it('publishes on a request, on its withdrawal and on gate observations from the status timer', () => {
    expect(index).toMatch(/onChange: \(\) => \{ queueRestartNotices\(\); publishRestartStatus\('request'\); \}/);
    expect(index).toMatch(/restartGuard\.evaluate\(\);\s*publishRestartStatus\('gate'\);/);
    expect(index).toMatch(/else if \(wasPending\) publishRestartStatus\('cleared'\);/);
  });

  it('runs the status timer: notices and a gate observation while pending, one clearing frame after', () => {
    const start = index.indexOf('// While a restart is requested: tell sessions');
    const end = index.indexOf('\n// The session a loopback API request acts for', start);
    let tick;
    const calls = [];
    let pending = true;
    let time = 0;
    runInNewContext(index.slice(start, end), {
      restartGuard: { pending: () => pending, evaluate: () => calls.push('evaluate') },
      queueRestartNotices: () => calls.push('notices'),
      publishRestartStatus: reason => calls.push(`publish ${reason}`),
      Date: { now: () => time }, console,
      setInterval: fn => { tick = fn; return { unref() {} }; },
    });
    tick();
    expect(calls).toEqual(['notices', 'evaluate', 'publish gate']);
    time += 1000;
    tick();
    expect(calls).toEqual(['notices', 'evaluate', 'publish gate', 'notices']);
    time += 5000;
    tick();
    expect(calls.slice(-3)).toEqual(['notices', 'evaluate', 'publish gate']);
    pending = false;
    tick();
    tick();
    expect(calls.filter(c => c === 'publish cleared')).toHaveLength(1);
  });

  it('keeps a restart request out of the plain box-status path: the route only replies on a read', () => {
    const at = index.indexOf("if (url.pathname === '/restart') {");
    const route = index.slice(at, index.indexOf("if (req.method !== 'POST') {", at));
    expect(route).toContain('restartGuard.handle(');
    expect(route).not.toContain('publishRestartStatus');
  });
});

it('publishes restart alongside every fork capacity field', () => {
  const frames = [];
  const claudeCache = { lines: ['claude'] }, codexCache = { lines: ['codex'] };
  const limits = { lines: ['claude', 'codex'] };
  const state = { state: 'pending' };
  const buildLimits = (claude, codex) => {
    expect(claude).toBe(claudeCache);
    expect(codex).toBe(codexCache);
    return limits;
  };
  const fn = publish.slice(0, publish.indexOf('export function publishRestartStatus('));
  runInNewContext(fn + "\npublishBoxStatus('restart');", {
    boxLock: null, JOURNAL_ENABLED: true, sessions: new Map(), loadPersistedSessions: () => [],
    buildActivity: () => ({ busy: 1 }), usageLimitsCache: claudeCache, codexLimits: { cache: codexCache }, buildLimits,
    DEFAULT_WORKDIR: '.', buildDisk: () => ({ free: 10 }), getAccountEmail: () => 'alice@example.test',
    boxVitals: () => ({ cpu: 20 }), pluginsReport: () => ({}), worktreeCleanup: { summary: () => null },
    defaultAgentInfo: () => ({ agent: 'codex', source: 'box' }), AGENT_CODEX: 'codex',
    codexDefaultModelNow: () => 'fixture-model', codexDefaultEffortNow: () => 'high',
    restartGuard: { pending: () => true, getState: () => state, lastVerdict: null },
    buildRestartStatus: value => value,
    journalPublisher: { sendRoomOp: frame => { frames.push(JSON.parse(JSON.stringify(frame))); return true; } }, debug() {},
  });
  expect(frames).toEqual([{ op: 'box_status', activity: { busy: 1 }, limits, disk: { free: 10 },
    account: { email: 'alice@example.test' }, vitals: { cpu: 20 },
    defaults: { agent: 'codex', model: 'fixture-model', effort: 'high', source: 'box' }, restart: state }]);
});
