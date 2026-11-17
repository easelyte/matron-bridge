import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// MATRON_VIEWER_TRUST_PROXY=loopback, as behind a tunnel daemon on this host:
// the limiters key on the forwarded client address, so one visitor spending
// the short-link lookup budget does not 429 another.

let server, base, tmpDir;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'viewer-trust-proxy-'));
  process.env.HMAC_SECRET = 'test-secret';
  process.env.MATRON_SHORT_LINKS_FILE = path.join(tmpDir, 'short-links.json');
  process.env.SHORT_LINK_RATE_LIMIT = '2';
  process.env.MATRON_VIEWER_TRUST_PROXY = 'loopback';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const lookup = (ip) => fetch(`${base}/l/AAAAAAAAAAAA`, { headers: { 'X-Forwarded-For': ip } }).then((r) => r.status);

describe('trusted proxy', () => {
  it('gives each forwarded client its own lookup budget', async () => {
    expect(await lookup('203.0.113.1')).toBe(403);
    expect(await lookup('203.0.113.1')).toBe(403);
    expect(await lookup('203.0.113.1')).toBe(429);
    // Another visitor through the same proxy is unaffected.
    expect(await lookup('203.0.113.2')).toBe(403);
  });

  it('keys on the address the proxy appended, so a forged leading X-Forwarded-For buys nothing', async () => {
    // A tunnel appends the visitor's address to whatever the visitor sent.
    expect(await lookup('198.51.100.1, 203.0.113.5')).toBe(403);
    expect(await lookup('198.51.100.2, 203.0.113.5')).toBe(403);
    expect(await lookup('198.51.100.3, 203.0.113.5')).toBe(429);
  });
});

describe('resolveTrustProxy', () => {
  it('is off unless set, and passes hop counts and address lists through', async () => {
    const { resolveTrustProxy } = await import('../viewer/server.js');
    for (const off of [undefined, '', 'off', 'false', 'no', '0']) {
      expect(resolveTrustProxy({ MATRON_VIEWER_TRUST_PROXY: off })).toBe(false);
    }
    expect(resolveTrustProxy({ MATRON_VIEWER_TRUST_PROXY: 'loopback' })).toBe('loopback');
    expect(resolveTrustProxy({ MATRON_VIEWER_TRUST_PROXY: '1' })).toBe(1);
    expect(resolveTrustProxy({ MATRON_VIEWER_TRUST_PROXY: 'true' })).toBe(true);
    expect(resolveTrustProxy({ MATRON_VIEWER_TRUST_PROXY: 'loopback, 10.0.0.0/8' })).toBe('loopback, 10.0.0.0/8');
  });
});
