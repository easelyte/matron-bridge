import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPageLinkHandler, pageLinkTtlSeconds, PAGE_LINK_DEFAULT_DAYS, PAGE_LINK_MAX_DAYS } from '../lib/page-link.js';
import { verifyToken } from '../lib/viewer-tokens.js';

const SECRET = 'page-link-secret';
let workdir, outside, handler;

beforeAll(() => {
  workdir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'page-link-wd-')));
  outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'page-link-out-')));
  writeFileSync(path.join(workdir, 'pack.html'), '<html></html>');
  writeFileSync(path.join(workdir, 'notes.txt'), 'hi');
  writeFileSync(path.join(outside, 'other.html'), '<html></html>');
  symlinkSync(path.join(outside, 'other.html'), path.join(workdir, 'escape.html'));
  const sessions = new Map([['room-1', { workdir }], ['room-nowd', {}]]);
  handler = createPageLinkHandler({ sessions, secret: SECRET, baseUrl: 'https://viewer.example.com' });
});
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const tokenOf = (url) => new URL(url).searchParams.get('token');

describe('page-link handler', () => {
  it('mints a page token for a relative path, scoped to the workdir, default 7 days', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { status, body } = await handler({ roomId: 'room-1', path: 'pack.html' });
    expect(status).toBe(200);
    expect(body.url).toMatch(/^https:\/\/viewer\.example\.com\/page\?token=/);
    expect(body.path).toBe(path.join(workdir, 'pack.html'));
    const data = verifyToken(tokenOf(body.url), SECRET);
    expect(data).toMatchObject({ path: path.join(workdir, 'pack.html'), workdir, page: true });
    expect(data.exp - before).toBeGreaterThanOrEqual(PAGE_LINK_DEFAULT_DAYS * 86400 - 1);
    expect(data.exp - before).toBeLessThanOrEqual(PAGE_LINK_DEFAULT_DAYS * 86400 + 1);
  });

  it('accepts an absolute path inside the workdir and a custom ttl', async () => {
    const { status, body } = await handler({ roomId: 'room-1', path: path.join(workdir, 'pack.html'), ttl_days: 3 });
    expect(status).toBe(200);
    const data = verifyToken(tokenOf(body.url), SECRET);
    expect(data.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3 * 86400 + 1);
  });

  it('caps the ttl and falls back to the default on nonsense', () => {
    expect(pageLinkTtlSeconds(365)).toBe(PAGE_LINK_MAX_DAYS * 86400);
    expect(pageLinkTtlSeconds(-1)).toBe(PAGE_LINK_DEFAULT_DAYS * 86400);
    expect(pageLinkTtlSeconds('9')).toBe(PAGE_LINK_DEFAULT_DAYS * 86400);
    expect(pageLinkTtlSeconds(undefined)).toBe(PAGE_LINK_DEFAULT_DAYS * 86400);
  });

  it('refuses a non-HTML file', async () => {
    const { status, body } = await handler({ roomId: 'room-1', path: 'notes.txt' });
    expect(status).toBe(403);
    expect(body.error).toMatch(/html/);
  });

  it('refuses a path outside the workdir', async () => {
    const { status, body } = await handler({ roomId: 'room-1', path: path.join(outside, 'other.html') });
    expect(status).toBe(403);
    expect(body.error).toMatch(/outside/);
  });

  it('refuses a symlink out of the workdir', async () => {
    const { status } = await handler({ roomId: 'room-1', path: 'escape.html' });
    expect(status).toBe(403);
  });

  it('404s a missing file', async () => {
    const { status } = await handler({ roomId: 'room-1', path: 'nope.html' });
    expect(status).toBe(404);
  });

  it('refuses a session without a workdir, an unknown room, and bad input', async () => {
    expect((await handler({ roomId: 'room-nowd', path: 'pack.html' })).status).toBe(400);
    expect((await handler({ roomId: 'room-x', path: 'pack.html' })).status).toBe(404);
    expect((await handler({ path: 'pack.html' })).status).toBe(400);
    expect((await handler({ roomId: 'room-1', path: ['a'] })).status).toBe(400);
  });

  it('500s when the viewer is not configured', async () => {
    const h = createPageLinkHandler({ sessions: new Map([['r', { workdir }]]), secret: '', baseUrl: '' });
    expect((await h({ roomId: 'r', path: 'pack.html' })).status).toBe(500);
  });
});
