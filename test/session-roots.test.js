import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pinSessionRoots } from '../lib/session-roots.js';
import { createPageLinkHandler } from '../lib/page-link.js';

let workdir;
beforeAll(() => {
  workdir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'session-roots-wd-')));
  writeFileSync(path.join(workdir, 'pack.html'), '<html></html>');
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const shareFor = async (session) => {
  const handler = createPageLinkHandler({
    sessions: new Map([['room', { workdir, ...session }]]),
    secret: 'secret',
    baseUrl: 'https://viewer.example.com',
  });
  return handler({ roomId: 'room', path: 'pack.html' });
};

describe('pinSessionRoots', () => {
  it('lets share_html_page work in a session without the share extra', async () => {
    const roots = pinSessionRoots({ cwd: workdir, shareEnabled: false, warn: () => {} });
    expect(roots.showFilePinnedRoots).toBeNull();
    expect(roots.showFileToken).toBeUndefined();
    const { status, body } = await shareFor(roots);
    expect(body.error).toBeUndefined();
    expect(status).toBe(200);
  });

  it('keeps page links working when an artifact root cannot be pinned', async () => {
    const warn = [];
    const roots = pinSessionRoots({
      cwd: workdir,
      shareEnabled: true,
      artifactRoots: [path.join(workdir, 'missing-artifacts')],
      warn: (m) => warn.push(m),
    });
    expect(roots.showFilePinnedRoots).toBeNull();
    expect(warn.join('\n')).toMatch(/show-file/);
    expect((await shareFor(roots)).status).toBe(200);
  });

  it('pins show_file roots and a token when share is on', () => {
    const roots = pinSessionRoots({ cwd: workdir, shareEnabled: true, warn: () => {} });
    expect(roots.showFilePinnedRoots.roots[0].realPath).toBe(workdir);
    expect(roots.showFileToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(roots.pageLinkPinnedRoots.roots[0].realPath).toBe(workdir);
  });

  it('leaves page links off when the workdir itself cannot be pinned', async () => {
    const roots = pinSessionRoots({ cwd: path.join(workdir, 'gone'), warn: () => {} });
    expect(roots.pageLinkPinnedRoots).toBeNull();
    expect((await shareFor(roots)).status).toBe(403);
  });
});
