import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// MATRON_VIEWER_TRUST_PROXY unset (the default): X-Forwarded-For is ignored,
// so a client cannot mint itself a fresh rate-limit budget by forging one.

let server, base, tmpDir;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'viewer-trust-proxy-off-'));
  process.env.HMAC_SECRET = 'test-secret';
  process.env.MATRON_SHORT_LINKS_FILE = path.join(tmpDir, 'short-links.json');
  process.env.SHORT_LINK_RATE_LIMIT = '2';
  delete process.env.MATRON_VIEWER_TRUST_PROXY;
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

describe('no trusted proxy', () => {
  it('ignores X-Forwarded-For: forged addresses share the one budget', async () => {
    expect(await lookup('203.0.113.1')).toBe(403);
    expect(await lookup('203.0.113.2')).toBe(403);
    expect(await lookup('203.0.113.3')).toBe(429);
  });
});
