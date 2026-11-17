import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SHORT_CODE_LENGTH,
  createShortLinkReader,
  createShortLinkWriter,
  generateShortCode,
  isShortCode,
  shortLinksEnabled,
  shortLinksFile,
  shortenViewerUrl,
} from '../lib/short-links.js';

let dir, file, clock;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'short-links-test-'));
  file = path.join(dir, 'short-links.json');
  clock = 1_800_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function signed(payload, secret = 'test-secret') {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}
const expIn = (s) => Math.floor(clock / 1000) + s;

describe('generateShortCode', () => {
  it('makes 12 letters and digits', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateShortCode();
      expect(code).toHaveLength(SHORT_CODE_LENGTH);
      expect(code).toMatch(/^[A-Za-z0-9]+$/);
      expect(isShortCode(code)).toBe(true);
    }
  });

  it('carries more than 64 bits of randomness', () => {
    expect(SHORT_CODE_LENGTH * Math.log2(62)).toBeGreaterThan(64);
  });

  it('does not repeat across many draws', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(generateShortCode());
    expect(seen.size).toBe(5000);
  });

  it('skips biased bytes (>= 248) rather than folding them onto the alphabet', () => {
    // First call: all biased, contributes nothing; second call: all zero -> 'A'.
    let calls = 0;
    const rb = (n) => Buffer.alloc(n, calls++ === 0 ? 250 : 0);
    expect(generateShortCode(rb)).toBe('A'.repeat(SHORT_CODE_LENGTH));
    expect(calls).toBe(2);
  });
});

describe('isShortCode', () => {
  it('rejects anything that is not exactly the code shape', () => {
    for (const bad of [undefined, null, 42, '', 'abc', 'A'.repeat(13), 'AAAAAAAAAAA-', 'AAAAAAAAAAA.', ['AAAAAAAAAAAA']]) {
      expect(isShortCode(bad)).toBe(false);
    }
  });
});

describe('shortLinksEnabled / shortLinksFile', () => {
  it('is on by default and off only when asked', () => {
    expect(shortLinksEnabled({})).toBe(true);
    expect(shortLinksEnabled({ MATRON_SHORT_LINKS: 'on' })).toBe(true);
    for (const off of ['off', 'OFF', '0', 'false', 'no']) expect(shortLinksEnabled({ MATRON_SHORT_LINKS: off })).toBe(false);
  });

  it('honours MATRON_SHORT_LINKS_FILE', () => {
    expect(shortLinksFile({ MATRON_SHORT_LINKS_FILE: '/x/y.json' })).toBe('/x/y.json');
    expect(shortLinksFile({})).toMatch(/\.matron-bridge-short-links\.json$/);
  });
});

describe('writer and reader', () => {
  it('a minted code resolves to its route and token', () => {
    const w = createShortLinkWriter({ file, now });
    const r = createShortLinkReader({ file, now });
    const code = w.add({ route: 'page', token: 'tok.sig', exp: expIn(60) });
    expect(isShortCode(code)).toBe(true);
    expect(r.resolve(code)).toEqual({ route: 'page', token: 'tok.sig' });
  });

  it('writes the store owner-only', () => {
    createShortLinkWriter({ file, now }).add({ route: 'page', token: 't.s', exp: expIn(60) });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('an unknown or malformed code resolves to null', () => {
    const w = createShortLinkWriter({ file, now });
    const r = createShortLinkReader({ file, now });
    w.add({ route: 'page', token: 't.s', exp: expIn(60) });
    expect(r.resolve('AAAAAAAAAAAA')).toBeNull();
    expect(r.resolve('nope')).toBeNull();
    expect(r.resolve('__proto__')).toBeNull();
    expect(r.resolve(undefined)).toBeNull();
  });

  it('resolves to null with no store file at all', () => {
    expect(createShortLinkReader({ file, now }).resolve('AAAAAAAAAAAA')).toBeNull();
  });

  it('a code dies with its token: it resolves up to exp and not one second after', () => {
    const w = createShortLinkWriter({ file, now });
    const r = createShortLinkReader({ file, now });
    const exp = expIn(60);
    const code = w.add({ route: 'sensitive', token: 't.s', exp });
    clock = exp * 1000;
    expect(r.resolve(code)).not.toBeNull();
    clock = (exp + 1) * 1000;
    expect(r.resolve(code)).toBeNull();
  });

  it('prunes expired entries on the next write, and prune() drops them on demand', () => {
    const w = createShortLinkWriter({ file, now });
    const old = w.add({ route: 'page', token: 'old.s', exp: expIn(10) });
    const keep = w.add({ route: 'page', token: 'keep.s', exp: expIn(1000) });
    clock += 60_000;
    expect(w.prune()).toBe(1);
    const stored = JSON.parse(readFileSync(file, 'utf8')).links;
    expect(Object.keys(stored)).toEqual([keep]);
    expect(stored[old]).toBeUndefined();
    expect(w.prune()).toBe(0);

    const later = w.add({ route: 'page', token: 'later.s', exp: expIn(5) });
    clock += 10_000;
    w.add({ route: 'page', token: 'next.s', exp: expIn(100) });
    expect(JSON.parse(readFileSync(file, 'utf8')).links[later]).toBeUndefined();
  });

  it('survives a restart: a new writer and reader on the same file see every live code', () => {
    const code1 = createShortLinkWriter({ file, now }).add({ route: 'page', token: 'a.s', exp: expIn(600) });
    // "Restart": fresh instances, no shared memory.
    const w2 = createShortLinkWriter({ file, now });
    const code2 = w2.add({ route: 'secret', token: 'b.s', exp: expIn(600) });
    const r2 = createShortLinkReader({ file, now });
    expect(r2.resolve(code1)).toEqual({ route: 'page', token: 'a.s' });
    expect(r2.resolve(code2)).toEqual({ route: 'secret', token: 'b.s' });
  });

  it('a long-lived reader sees codes minted after its first read', () => {
    const w = createShortLinkWriter({ file, now });
    const r = createShortLinkReader({ file, now });
    const a = w.add({ route: 'page', token: 'a.s', exp: expIn(600) });
    expect(r.resolve(a)).not.toBeNull();
    const b = w.add({ route: 'page', token: 'b.s', exp: expIn(600) });
    expect(r.resolve(b)).toEqual({ route: 'page', token: 'b.s' });
  });

  it('ignores a corrupt store (no throw, no resolution) and the writer starts it over', () => {
    writeFileSync(file, '{not json');
    const r = createShortLinkReader({ file, now });
    expect(r.resolve('AAAAAAAAAAAA')).toBeNull();
    const code = createShortLinkWriter({ file, now }).add({ route: 'page', token: 't.s', exp: expIn(60) });
    expect(r.resolve(code)).not.toBeNull();
  });

  it('ignores entries for routes it does not know', () => {
    writeFileSync(file, JSON.stringify({ version: 1, links: { AAAAAAAAAAAA: { r: 'live', t: 't.s', e: expIn(60) } } }));
    expect(createShortLinkReader({ file, now }).resolve('AAAAAAAAAAAA')).toBeNull();
  });

  it('refuses unsupported routes and missing fields', () => {
    const w = createShortLinkWriter({ file, now });
    expect(() => w.add({ route: 'live', token: 't.s', exp: expIn(60) })).toThrow();
    expect(() => w.add({ route: 'page', token: '', exp: expIn(60) })).toThrow();
    expect(() => w.add({ route: 'page', token: 't.s' })).toThrow();
  });

  it('caps the store, dropping the soonest-expiring codes but never the new one', () => {
    const w = createShortLinkWriter({ file, now, maxEntries: 3 });
    const r = createShortLinkReader({ file, now });
    const a = w.add({ route: 'page', token: 'a.s', exp: expIn(100) });
    const b = w.add({ route: 'page', token: 'b.s', exp: expIn(300) });
    const c = w.add({ route: 'page', token: 'c.s', exp: expIn(400) });
    const d = w.add({ route: 'page', token: 'd.s', exp: expIn(50) });
    expect(r.resolve(a)).toBeNull();
    for (const code of [b, c, d]) expect(r.resolve(code)).not.toBeNull();
  });

  it('draws again on a collision', () => {
    let n = 0;
    // Two identical draws, then a different one.
    const rb = (size) => Buffer.alloc(size, n++ < 2 ? 0 : 1);
    const w = createShortLinkWriter({ file, now, randomBytes: rb });
    const first = w.add({ route: 'page', token: 'a.s', exp: expIn(60) });
    const second = w.add({ route: 'page', token: 'b.s', exp: expIn(60) });
    expect(first).not.toBe(second);
  });
});

describe('shortenViewerUrl', () => {
  it('turns a long viewer link into <base>/l/<code> expiring with the token', () => {
    const w = createShortLinkWriter({ file, now });
    const token = signed({ sensitiveId: 's1', label: 'k', exp: expIn(300) });
    const short = shortenViewerUrl(w, `https://viewer.example/sensitive?token=${token}`);
    const m = short.match(/^https:\/\/viewer\.example\/l\/([A-Za-z0-9]{12})$/);
    expect(m).toBeTruthy();
    const stored = JSON.parse(readFileSync(file, 'utf8')).links[m[1]];
    expect(stored).toEqual({ r: 'sensitive', t: token, e: expIn(300) });
  });

  it('keeps a path prefix on the viewer base URL', () => {
    const w = createShortLinkWriter({ file, now });
    const token = signed({ page: true, p: 'x', exp: expIn(300) });
    expect(shortenViewerUrl(w, `https://host.example/viewer/page?token=${token}`)).toMatch(/^https:\/\/host\.example\/viewer\/l\/[A-Za-z0-9]{12}$/);
  });

  it('hands back the long link when shortening is off, the store fails, or the link is not shortenable', () => {
    const token = signed({ page: true, p: 'x', exp: expIn(300) });
    const long = `https://viewer.example/page?token=${token}`;
    expect(shortenViewerUrl(null, long)).toBe(long);

    const broken = createShortLinkWriter({ file: path.join(dir, 'missing-dir', 'x.json'), now });
    const warn = [];
    expect(shortenViewerUrl(broken, long, { log: { warn: (m) => warn.push(m) } })).toBe(long);
    expect(warn).toHaveLength(1);

    const w = createShortLinkWriter({ file, now });
    const live = `https://viewer.example/live?token=${token}`;
    expect(shortenViewerUrl(w, live)).toBe(live);
    expect(shortenViewerUrl(w, 'https://viewer.example/page')).toBe('https://viewer.example/page');
    expect(shortenViewerUrl(w, 'not a url')).toBe('not a url');
  });
});
