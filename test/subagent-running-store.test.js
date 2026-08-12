import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSubagentRunningStore } from '../lib/subagent-running-store.js';

describe('subagent-running-store', () => {
  let dir;
  let file;
  let store;

  beforeEach(() => {
    // A private 0700 temp DIR (not a bare name in the shared tmpdir) so the
    // store file + its siblings (.tmp, .corrupt-*) can't collide with or be
    // pre-created by another user, and cleanup is a single recursive remove.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-running-'));
    file = path.join(dir, 'store.json');
    store = createSubagentRunningStore({ file });
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('list() is empty before anything is added (missing file)', () => {
    expect(store.list()).toEqual([]);
  });

  it('add() then list() returns the child with parent + agent', () => {
    store.add('p1:sub:a1', { parentConvoId: 'p1', agentId: 'a1' });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ childConvoId: 'p1:sub:a1', parentConvoId: 'p1', agentId: 'a1' });
    expect(typeof list[0].addedAt).toBe('number');
  });

  it('remove() drops the record', () => {
    store.add('p1:sub:a1', { parentConvoId: 'p1', agentId: 'a1' });
    store.remove('p1:sub:a1');
    expect(store.list()).toEqual([]);
  });

  it('add() is idempotent and preserves the original addedAt', async () => {
    store.add('p1:sub:a1', { parentConvoId: 'p1', agentId: 'a1' });
    const first = store.list()[0].addedAt;
    await new Promise(r => setTimeout(r, 5));
    store.add('p1:sub:a1', { parentConvoId: 'p1', agentId: 'a1' });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].addedAt).toBe(first);
  });

  it('persists across a fresh store instance on the same file (survives restart)', () => {
    store.add('p1:sub:a1', { parentConvoId: 'p1', agentId: 'a1' });
    store.add('p2:sub:b2', { parentConvoId: 'p2', agentId: 'b2' });
    const reopened = createSubagentRunningStore({ file });
    const ids = reopened.list().map(e => e.childConvoId).sort();
    expect(ids).toEqual(['p1:sub:a1', 'p2:sub:b2']);
  });

  it('ignores adds with no childConvoId or no parentConvoId', () => {
    store.add('', { parentConvoId: 'p1', agentId: 'a1' });
    store.add('p1:sub:a1', { parentConvoId: '', agentId: 'a1' });
    store.add('p1:sub:a1', {});
    expect(store.list()).toEqual([]);
  });

  it('quarantines a corrupt file instead of silently overwriting it (F3)', () => {
    fs.writeFileSync(file, '{ this is not json');
    // list() returns empty (can't reconcile), but the corrupt bytes are moved
    // aside — NOT left in place to be overwritten from {} on the next add.
    expect(store.list()).toEqual([]);
    const dir = path.dirname(file);
    const base = path.basename(file);
    const quarantined = fs.readdirSync(dir).filter(n => n.startsWith(`${base}.corrupt-`));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8')).toBe('{ this is not json');
    // The original path is now free, so a fresh add starts a clean store.
    store.add('p1:sub:a1', { parentConvoId: 'p1', agentId: 'a1' });
    expect(store.list()).toHaveLength(1);
  });

  it('a non-object JSON payload is treated as corrupt and quarantined', () => {
    fs.writeFileSync(file, '[1,2,3]');
    expect(store.list()).toEqual([]);
    const dir = path.dirname(file);
    const base = path.basename(file);
    expect(fs.readdirSync(dir).filter(n => n.startsWith(`${base}.corrupt-`))).toHaveLength(1);
  });

  it('remove() on an absent id is a no-op', () => {
    store.add('p1:sub:a1', { parentConvoId: 'p1', agentId: 'a1' });
    store.remove('nope');
    expect(store.list()).toHaveLength(1);
  });

  it('add()/remove() return an explicit durable-success boolean (F2)', () => {
    expect(store.add('p1:sub:a1', { parentConvoId: 'p1', agentId: 'a1' })).toBe(true);
    expect(store.add('p1:sub:a1', { parentConvoId: 'p1', agentId: 'a1' })).toBe(true); // idempotent no-op
    expect(store.add('', { parentConvoId: 'p1' })).toBe(false);                        // rejected args
    expect(store.remove('p1:sub:a1')).toBe(true);
    expect(store.remove('nope')).toBe(true);                                            // absent no-op
  });

  it('refuses to overwrite a present-but-unreadable file, returning false (F4)', () => {
    // Simulate an unreadable-but-present file with a directory at the path:
    // readFileSync throws EISDIR (not ENOENT) → status 'unreadable'.
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    fs.mkdirSync(file);
    try {
      expect(store.list()).toEqual([]);                                    // can't read → empty, but…
      expect(store.add('p1:sub:a1', { parentConvoId: 'p1', agentId: 'a1' })).toBe(false); // …refuses to write
      expect(store.remove('p1:sub:a1')).toBe(false);
      // The original path is untouched (still the directory), not replaced by a file.
      expect(fs.statSync(file).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(file, { recursive: true, force: true });
    }
  });
});
