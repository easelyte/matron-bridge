import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRestartStatus } from '../lib/box-status-restart.js';
import { createPlannedRestartState } from '../lib/planned-restart-state.js';
import { createPlannedRestart } from '../lib/planned-restart.js';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const publish = index.slice(index.indexOf('function publishBoxStatus('), index.indexOf('const journalPublisher ='));

describe('restart box status wiring', () => {
  it.each(['sent', 'disconnected', 'exception'])('returns the publisher outcome for %s without interrupting state changes', outcome => {
    const calls = [];
    const seam = index.slice(index.indexOf('export function publishRestartStatus('),
      index.indexOf('\nif (plannedRestartAvailable)', index.indexOf('export function publishRestartStatus(')));
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

  it('publishes committed requests, cancellation and recovery through the production publisher', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'box-status-'));
    try {
      const store = createPlannedRestartState({ file: path.join(dir, 'state.json'),
        historyFile: path.join(dir, 'history.jsonl'), now: () => 100, makeId: () => 'restart-a' });
      const frames = [];
      const runtime = { gateVerdict: { waiting_on: { quiet: { holders: [], probe_error: null },
        code: null, preflight: null, collect: null, unwarned: [] } } };
      runInNewContext(publish.replace('export ', ''), {
        JOURNAL_ENABLED: true, plannedRestartAvailable: true, plannedRestartState: store,
        plannedRestartRuntime: runtime, buildRestartStatus,
        sessions: new Map(), loadPersistedSessions: () => [], buildActivity: () => null,
        usageLimitsCache: null, codexLimits: { cache: null }, buildBoxVitals: () => null, hostVitals: () => null, buildLimits: () => null, DEFAULT_WORKDIR: '.', buildDisk: () => null,
        getAccountEmail: () => null, defaultAgentInfo: () => { throw new Error('unavailable'); },
        journalPublisher: { sendRoomOp: frame => { frames.push(JSON.parse(JSON.stringify(frame))); return true; } },
        debug: () => {},
      });
      store.addRequest({ request_key: 'alice', sha: 'abc', reason: 'update' });
      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual({ op: 'box_status', restart: buildRestartStatus(store.getState(), runtime.gateVerdict) });
      expect(frames[0].restart.state).toBe('pending');
      store.setState('cancelled');
      expect(frames).toHaveLength(2);
      expect(frames[1]).toEqual({ op: 'box_status', restart: buildRestartStatus(store.getState(), runtime.gateVerdict) });
      expect(frames[1].restart.state).toBe('cancelled');
      store.setState('back', { expected_sha: 'abc', results: ['alice'] });
      expect(frames).toHaveLength(3);
      expect(frames[2]).toEqual({ op: 'box_status', restart: buildRestartStatus(store.getState(), runtime.gateVerdict) });
      expect(frames[2].restart).toMatchObject({ state: 'back', expected_sha: 'abc', results: ['alice'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds restart status from durable state and the last gate verdict and sends it alone', () => {
    expect(publish).toContain('buildRestartStatus(plannedRestartState?.getState(), plannedRestartRuntime.gateVerdict)');
    expect(publish).toContain('&& !restart) return false;');
    expect(publish).toContain('...(restart ? { restart } : {}),');
  });

  it('exports a synchronous publish seam and observes committed request and state changes', () => {
    expect(index).toMatch(/export function publishRestartStatus\(reason\)/);
    expect(index).toMatch(/for \(const method of \['addRequest', 'setState'\]\)/);
    expect(index).toMatch(/const result = mutate\(\.\.\.args\);[\s\S]*?publishRestartStatus\(method\);\s*return result;/);
  });

  it('publishes real gate observations while dry runs only reply', () => {
    expect(index).toMatch(/plannedRestartRuntime\.gateVerdict = plannedRestart\.tick\(\);\s*publishRestartStatus\('gate'\);/);
    const dryRun = index.slice(index.indexOf("if (url.pathname === '/restart/dry-run')"), index.indexOf("if (url.pathname === '/restart/dry-run')") + 200);
    expect(dryRun).not.toContain('publishRestartStatus');
    expect(dryRun).toContain('dryRun: true');
  });
});

it('publishes changed gate observations from the production timer and sanitizes preflight stderr', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'box-gate-'));
  try {
    const store = createPlannedRestartState({ file: path.join(dir, 'state.json'), makeId: () => 'alice', now: () => 100 });
    store.persistBootSha('head');
    store.addRequest({ request_key: 'bob' });
    let observed = { quiet: false, holders: [{ convoId: 'bob', why: 'busy' }], probe_error: null };
    const secret = 'credential-sentinel';
    const gate = createPlannedRestart({ repoDir: '.', stateStore: store, now: () => 100, collectMs: 0,
      git: args => args[0] === 'rev-parse' ? 'head' : args[0] === 'merge-base' ? true : '',
      fs: { readFileSync: () => Buffer.from('fixture'), statSync: () => ({ ino: 1, mtimeMs: 1 }) },
      quietEvaluator: () => observed, support: () => 'gate/1',
      preflight: async () => ({ ok: false, error: `preflight failed: ${secret}`, stderr: secret }),
    });
    const frames = [];
    let tick;
    const runtime = { gateVerdict: null };
    let time = 0;
    const context = {
      JOURNAL_ENABLED: true, plannedRestartAvailable: true, plannedRestartState: store, Date: { now: () => time },
      plannedRestartRuntime: runtime, plannedRestart: gate, buildRestartStatus,
      sessions: new Map(), loadPersistedSessions: () => [], buildActivity: () => null,
      usageLimitsCache: null, codexLimits: { cache: null }, buildBoxVitals: () => null, hostVitals: () => null, buildLimits: () => null, DEFAULT_WORKDIR: '.', buildDisk: () => null,
      getAccountEmail: () => null, defaultAgentInfo: () => { throw new Error('unavailable'); },
      journalPublisher: { sendRoomOp: frame => { frames.push(JSON.parse(JSON.stringify(frame))); return true; } },
      debug: () => {}, queueRestartNotices: () => {}, codeUpdateWatcher: null, console,
      setInterval: fn => { tick = fn; return { unref() {} }; },
    };
    const start = index.indexOf('if (plannedRestartAvailable) {\n  let previousState;');
    const end = index.indexOf('\nconst apiServer =', start);
    runInNewContext(publish.replace('export ', '') + index.slice(start, end), context);
    tick();
    expect(frames.at(-1)?.restart?.waiting_on?.quiet?.holders).toEqual([{ convoId: 'bob', why: 'busy' }]);
    observed = { quiet: false, holders: [], probe_error: 'process_table' };
    time += 5000;
    tick();
    expect(frames.at(-1)?.restart?.waiting_on?.quiet).toEqual({ holders: [], probe_error: 'process_table' });
    await Promise.resolve();
    time += 5000;
    tick();
    expect(frames.at(-1)?.restart?.waiting_on?.preflight).toEqual({ error: 'preflight failed' });
    expect(JSON.stringify(frames)).not.toContain(secret);
    const before = frames.length;
    const dryStart = index.indexOf("if (url.pathname === '/restart/dry-run')");
    const dryEnd = index.indexOf('\n    try {', dryStart);
    const dry = runInNewContext('(async () => {' + index.slice(dryStart, dryEnd) + '})', {
      url: { pathname: '/restart/dry-run' }, plannedRestart: gate, data: {}, reply: () => {},
    });
    await dry();
    expect(frames).toHaveLength(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
    JOURNAL_ENABLED: true, sessions: new Map(), loadPersistedSessions: () => [],
    buildActivity: () => ({ busy: 1 }), usageLimitsCache: claudeCache, codexLimits: { cache: codexCache }, buildLimits,
    DEFAULT_WORKDIR: '.', buildDisk: () => ({ free: 10 }), getAccountEmail: () => 'alice@example.test',
    hostVitals: () => ({ cpu: 20 }), buildBoxVitals: value => value,
    defaultAgentInfo: () => ({ agent: 'codex', source: 'box' }), AGENT_CODEX: 'codex',
    codexDefaultModelNow: () => 'fixture-model', codexDefaultEffortNow: () => 'high',
    plannedRestartState: { getState: () => state }, plannedRestartRuntime: { gateVerdict: null },
    buildRestartStatus: value => value,
    journalPublisher: { sendRoomOp: frame => { frames.push(JSON.parse(JSON.stringify(frame))); return true; } }, debug() {},
  });
  expect(frames).toEqual([{ op: 'box_status', activity: { busy: 1 }, limits, disk: { free: 10 },
    account: { email: 'alice@example.test' }, vitals: { cpu: 20 },
    defaults: { agent: 'codex', model: 'fixture-model', effort: 'high', source: 'box' }, restart: state }]);
});
