import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  parseThresholds,
  parseIntEnv,
  DEFAULT_THRESHOLDS,
  evaluateWindow,
  fetchUsage,
  classifyFailure,
  usableWindowCount,
  LimitsFetchError,
  readOAuthToken,
  formatLimits,
  formatAlert,
  allMembersAllowed,
  bandHex,
} from '../lib/limits.js';

const noLog = { warn: () => {} };
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-limits-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseThresholds', () => {
  it('parses a valid list sorted + deduped', () => {
    expect(parseThresholds('95,50,85,50', noLog)).toEqual([50, 85, 95]);
  });
  it('falls back to defaults on any malformed entry', () => {
    const log = { warn: vi.fn() };
    expect(parseThresholds('50,x,95', log)).toEqual(DEFAULT_THRESHOLDS);
    expect(log.warn).toHaveBeenCalled();
  });
  it('rejects out-of-range and empty', () => {
    expect(parseThresholds('0,120', noLog)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds('', noLog)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds(undefined, noLog)).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe('parseIntEnv', () => {
  it('returns a finite value for valid input', () => {
    expect(parseIntEnv('60000', { name: 'X', def: 300000, min: 1 }, noLog)).toBe(60000);
  });
  it('non-finite garbage warns + returns default', () => {
    const log = { warn: vi.fn() };
    expect(parseIntEnv('abc', { name: 'X', def: 300000, min: 1 }, log)).toBe(300000);
    expect(log.warn).toHaveBeenCalled();
  });
  it('below-min warns + returns default (non-sentinel knob)', () => {
    expect(parseIntEnv('0', { name: 'X', def: 3, min: 1 }, noLog)).toBe(3);
  });
  it('POLL_MS carve-out: non-finite -> default, but <=0 preserved as disable sentinel', () => {
    expect(parseIntEnv('abc', { name: 'POLL_MS', def: 300000, min: 1, allowDisableSentinel: true }, noLog)).toBe(300000);
    expect(parseIntEnv('0', { name: 'POLL_MS', def: 300000, min: 1, allowDisableSentinel: true }, noLog)).toBe(0);
    expect(parseIntEnv('-5', { name: 'POLL_MS', def: 300000, min: 1, allowDisableSentinel: true }, noLog)).toBe(0);
  });
});

const T = [50, 85, 95];
const seed = { tier: 0, isFirstPoll: true };

describe('evaluateWindow', () => {
  it('first poll seeds silently even when already above a tier', () => {
    const r = evaluateWindow({ utilization: 87, prev: seed, thresholds: T });
    expect(r.crossedTier).toBeNull();
    expect(r.nextState).toEqual({ tier: 85, isFirstPoll: false });
  });
  it('rising edge emits once at the highest crossed tier (40 -> 90)', () => {
    const r = evaluateWindow({ utilization: 90, prev: { tier: 0, isFirstPoll: false }, thresholds: T });
    expect(r.crossedTier).toBe(85);
    expect(r.nextState.tier).toBe(85);
  });
  it('steady below current tier boundary does not emit', () => {
    const r = evaluateWindow({ utilization: 86, prev: { tier: 85, isFirstPoll: false }, thresholds: T });
    expect(r.crossedTier).toBeNull();
    expect(r.nextState.tier).toBe(85);
  });
  it('drop-below re-arms without emit', () => {
    const r = evaluateWindow({ utilization: 40, prev: { tier: 85, isFirstPoll: false }, thresholds: T });
    expect(r.crossedTier).toBeNull();
    expect(r.nextState.tier).toBe(0);
  });
  it('does not mutate prev', () => {
    const prev = { tier: 0, isFirstPoll: false };
    evaluateWindow({ utilization: 90, prev, thresholds: T });
    expect(prev).toEqual({ tier: 0, isFirstPoll: false });
  });
  it('custom thresholds: tier can be a non-default value', () => {
    const r = evaluateWindow({ utilization: 5, prev: { tier: 0, isFirstPoll: false }, thresholds: [1] });
    expect(r.crossedTier).toBe(1);
  });
});

function fakeFetch(status, body, { throwJson = false } = {}) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (throwJson) throw new SyntaxError('bad json');
      return body;
    },
  });
}

describe('fetchUsage', () => {
  it('normalizes a happy 200', async () => {
    const body = {
      five_hour: { utilization: 10, resets_at: '2026-07-11T23:00:00Z' },
      seven_day: { utilization: 6, resets_at: '2026-07-18T09:00:00Z' },
    };
    const r = await fetchUsage({ token: 't', fetchImpl: fakeFetch(200, body) });
    expect(r.fiveHour).toEqual({ utilization: 10, resetsAt: '2026-07-11T23:00:00Z' });
    expect(r.sevenDay.utilization).toBe(6);
  });
  it('shape drift (missing windows) does NOT throw, yields null utilizations', async () => {
    const r = await fetchUsage({ token: 't', fetchImpl: fakeFetch(200, { renamed: {} }) });
    expect(r.fiveHour.utilization).toBeNull();
    expect(usableWindowCount(r)).toBe(0);
  });
  it('non-200 throws LimitsFetchError with status', async () => {
    await expect(fetchUsage({ token: 't', fetchImpl: fakeFetch(401, {}) }))
      .rejects.toMatchObject({ status: 401 });
  });
  it('2xx non-200 throws LimitsFetchError with status', async () => {
    await expect(fetchUsage({ token: 't', fetchImpl: fakeFetch(204, {}) }))
      .rejects.toMatchObject({ status: 204 });
  });
  it('calls the usage endpoint with oauth headers', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ five_hour: {}, seven_day: {} }),
    }));
    await fetchUsage({ token: 'secret-token', fetchImpl, timeoutMs: 1234 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', expect.objectContaining({
      headers: {
        Authorization: 'Bearer secret-token',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }));
  });
  it('non-JSON 200 body throws malformed', async () => {
    await expect(fetchUsage({ token: 't', fetchImpl: fakeFetch(200, null, { throwJson: true }) }))
      .rejects.toBeInstanceOf(LimitsFetchError);
  });
});

describe('classifyFailure', () => {
  it('5xx and 429 are transient', () => {
    expect(classifyFailure(new LimitsFetchError('x', { status: 503 })).class).toBe('transient');
    expect(classifyFailure(new LimitsFetchError('x', { status: 429 })).class).toBe('transient');
  });
  it('401/403 permanent stale-token', () => {
    expect(classifyFailure(new LimitsFetchError('x', { status: 401 }))).toEqual({ class: 'permanent', reason: 'stale-token' });
    expect(classifyFailure(new LimitsFetchError('x', { status: 403 }))).toEqual({ class: 'permanent', reason: 'stale-token' });
  });
  it('other 4xx and non-JSON permanent malformed', () => {
    expect(classifyFailure(new LimitsFetchError('x', { status: 400 }))).toEqual({ class: 'permanent', reason: 'malformed' });
    expect(classifyFailure(new LimitsFetchError('x', { status: 200, malformedBody: true }))).toEqual({ class: 'permanent', reason: 'malformed' });
  });
  it('network error (no status) is transient', () => {
    expect(classifyFailure(new Error('ECONNRESET')).class).toBe('transient');
  });
});

describe('readOAuthToken', () => {
  it('missing file returns null', () => {
    expect(readOAuthToken({ credsPath: '/nonexistent/x.json' })).toBeNull();
  });
  it('reads a valid credentials file', () => {
    const credsPath = path.join(makeTempDir(), 'credentials.json');
    fs.writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));

    expect(readOAuthToken({ credsPath })).toBe('tok');
  });
  it('missing claudeAiOauth access token returns null', () => {
    const credsPath = path.join(makeTempDir(), 'credentials.json');
    fs.writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: {} }));

    expect(readOAuthToken({ credsPath })).toBeNull();
  });
  it('malformed JSON returns null', () => {
    const credsPath = path.join(makeTempDir(), 'credentials.json');
    fs.writeFileSync(credsPath, '{bad json');

    expect(readOAuthToken({ credsPath })).toBeNull();
  });
  it('expands tilde in the credentials path', () => {
    const home = makeTempDir();
    const relPath = path.join('.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(path.join(home, relPath)), { recursive: true });
    fs.writeFileSync(path.join(home, relPath), JSON.stringify({ claudeAiOauth: { accessToken: 'home-token' } }));
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    expect(readOAuthToken({ credsPath: `~/${relPath}` })).toBe('home-token');
  });
});

const NOW = Date.parse('2026-07-11T20:00:00Z');

describe('bandHex', () => {
  it('bands at boundaries', () => {
    expect(bandHex(49)).toBe('#3fb950');
    expect(bandHex(50)).toBe('#f0883e');
    expect(bandHex(85)).toBe('#d29922');
    expect(bandHex(95)).toBe('#f85149');
  });
});

describe('formatLimits', () => {
  it('renders resets: unknown when resetsAt null but util present', () => {
    const out = formatLimits({
      fiveHour: { utilization: 87, resetsAt: null },
      sevenDay: { utilization: 6, resetsAt: '2026-07-18T09:00:00Z' },
      now: NOW,
    });
    expect(out.plain).toMatch(/resets: unknown/);
    expect(out.plain).not.toMatch(/NaN/);
  });
  it('renders unavailable for a null-util window, not 0%', () => {
    const out = formatLimits({
      fiveHour: { utilization: null, resetsAt: null },
      sevenDay: { utilization: 6, resetsAt: null },
      now: NOW,
    });
    expect(out.plain).toMatch(/unavailable/);
    expect(out.plain).not.toMatch(/0%/);
  });
});

describe('formatAlert', () => {
  it('null resetsAt: no reset clause, no NaN', () => {
    const out = formatAlert({ window: '7-day', utilization: 87, tier: 85, resetsAt: null, now: NOW });
    expect(out.plain).not.toMatch(/NaN|resets in/);
  });
});

describe('allMembersAllowed', () => {
  const bot = '@bot:server';
  it('empty allow-list => true (allow-any)', () => {
    expect(allMembersAllowed(['@x:s', '@y:s'], [], bot)).toBe(true);
  });
  it('all non-bot members allowed => true', () => {
    expect(allMembersAllowed(['@op:s', bot], ['@op:s'], bot)).toBe(true);
  });
  it('any unauthorized member => false', () => {
    expect(allMembersAllowed(['@op:s', '@stranger:s'], ['@op:s'], bot)).toBe(false);
  });
});
