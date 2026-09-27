import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { filterFileRpcRoots } from '../lib/file-rpc-roots.js';

describe('filterFileRpcRoots (read_file / edit_file roots)', () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'file-rpc-roots-')));
  const home = path.join(base, 'home', 'u');
  const ws = path.join(home, '.openclaw', 'workspace');
  const other = path.join(base, 'srv');
  mkdirSync(ws, { recursive: true });
  mkdirSync(other, { recursive: true });
  symlinkSync(home, path.join(base, 'home-link'));

  it('refuses a root of /', () => {
    const r = filterFileRpcRoots(['/', ws], { home });
    expect(r.kept).toEqual([ws]);
    expect(r.refused).toEqual([{ root: '/', reason: 'filesystem-root' }]);
  });

  it('refuses $HOME, a symlink to it, and any ancestor of it', () => {
    const r = filterFileRpcRoots([home, path.join(base, 'home-link'), path.join(base, 'home'), other], { home });
    expect(r.kept).toEqual([other]);
    expect(r.refused.map((x) => x.reason)).toEqual(['home', 'home', 'contains-home']);
  });

  it('keeps a root inside $HOME (an explicit workspace) and unrelated roots', () => {
    const r = filterFileRpcRoots([ws, other, ws], { home });
    expect(r.kept).toEqual([ws, other]);
    expect(r.refused).toEqual([]);
  });

  it('refuses every root when the passwd home is unknown (never trusts $HOME)', () => {
    const r = filterFileRpcRoots([ws, other], { home: null });
    expect(r.kept).toEqual([]);
    expect(r.refused.map((x) => x.reason)).toEqual(['home-unknown', 'home-unknown']);
  });

  it('an all-refused set comes back empty (the RPCs then fail closed with bad_workdir)', () => {
    expect(filterFileRpcRoots([home], { home }).kept).toEqual([]);
  });
});

describe('index.js wiring', () => {
  it('pins the read_file / edit_file roots only from the filtered set', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    expect(src).toContain('filterFileRpcRoots([DEFAULT_WORKDIR, ...SHOW_FILE_ARTIFACT_ROOTS])');
    expect(src).toContain('const editAllowedRoots = pinAllowedRootsSync(fileRpcRoots.kept);');
    expect(src).not.toContain('pinAllowedRootsSync([DEFAULT_WORKDIR, ...SHOW_FILE_ARTIFACT_ROOTS])');
  });
});
