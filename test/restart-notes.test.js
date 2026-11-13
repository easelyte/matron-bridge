import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRestartNotes } from '../lib/restart-notes.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-notes-'));
  roots.push(root);
  const options = { heldFile: path.join(root, 'held.json'), pendingFile: path.join(root, 'pending.json'), now: () => 100, ...overrides };
  return { options, notes: createRestartNotes(options) };
}

describe('restart notes', () => {
  it.each([null, ''])('refuses an invalid move id %j', id => {
    const { notes } = fixture();
    expect(() => notes.moveToPending(id)).toThrow('Invalid restart note id');
  });

  it('replaces only the matching restart and conversation, retaining the latest write time across reload', () => {
    const { options, notes } = fixture();
    notes.hold('restart-a', 'alice', 'first');
    notes.hold('restart-a', 'bob', 'other conversation');
    notes.hold('restart-b', 'alice', 'other restart');
    createRestartNotes({ ...options, now: () => 200 }).hold('restart-a', 'alice', 'replacement');
    expect(createRestartNotes(options).listHeld('restart-a')).toEqual([
      { id: 'restart-a', convoId: 'alice', text: 'replacement', writtenAt: 200 },
      { id: 'restart-a', convoId: 'bob', text: 'other conversation', writtenAt: 100 },
    ]);
    expect(notes.listHeld('restart-b')).toHaveLength(1);
    if (process.platform !== 'win32') expect(fs.statSync(options.heldFile).mode & 0o777).toBe(0o600);
  });

  it('moves a restart once and preserves the note timestamp and other restarts', () => {
    const { options, notes } = fixture();
    notes.hold('restart-a', 'alice', 'resume');
    notes.hold('restart-b', 'bob', 'wait');
    expect(() => notes.moveToPending('restart-a')).not.toThrow();
    expect(() => notes.moveToPending('restart-a')).not.toThrow();
    const reload = createRestartNotes(options);
    expect(reload.listPending('restart-a')).toEqual([{ id: 'restart-a', convoId: 'alice', text: 'resume', writtenAt: 100 }]);
    expect(reload.listHeld('restart-a')).toEqual([]);
    expect(reload.listHeld('restart-b')).toHaveLength(1);
    if (process.platform !== 'win32') expect(fs.statSync(options.pendingFile).mode & 0o777).toBe(0o600);
  });

  it.each(['heldFile', 'pendingFile'])('refuses unreadable %s without losing held notes', fileKey => {
    const { options, notes } = fixture();
    notes.hold('restart-a', 'alice', 'resume');
    const broken = createRestartNotes({ ...options, fs: { ...fs, readFileSync: (file, ...args) => {
      if (file === options[fileKey]) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return fs.readFileSync(file, ...args);
    } } });
    expect(() => broken.moveToPending('restart-a')).toThrow('unreadable');
    expect(notes.listHeld('restart-a')).toHaveLength(1);
  });

  it.each(['heldFile', 'pendingFile'])('refuses malformed %s rather than overwriting it', fileKey => {
    const { options, notes } = fixture();
    fs.writeFileSync(options[fileKey], '{');
    expect(() => notes.moveToPending('restart-a')).toThrow();
    expect(fs.readFileSync(options[fileKey], 'utf8')).toBe('{');
  });

  it.each(['heldFile', 'pendingFile'])('refuses invalid records in %s', fileKey => {
    const { options, notes } = fixture();
    fs.writeFileSync(options[fileKey], '[{"id":"restart-a"}]');
    expect(() => notes.moveToPending('restart-a')).toThrow('Invalid restart notes');
  });

  it.each(['heldFile', 'pendingFile'])('recovers an interrupted move at %s without duplicates or lost notes', fileKey => {
    const { options, notes } = fixture();
    notes.hold('restart-a', 'alice', 'resume');
    const broken = createRestartNotes({ ...options, fs: { ...fs, renameSync: (from, to) => {
      if (to === options[fileKey]) throw new Error('disk failure');
      fs.renameSync(from, to);
    } } });
    expect(() => broken.moveToPending('restart-a')).toThrow('disk failure');
    expect(notes.listHeld('restart-a')).toHaveLength(1);
    expect(() => notes.moveToPending('restart-a')).not.toThrow();
    expect(() => notes.moveToPending('restart-a')).not.toThrow();
    expect(notes.listPending('restart-a')).toHaveLength(1);
    expect(notes.listHeld('restart-a')).toEqual([]);
  });

  it('refuses failed holds without acknowledging or replacing durable text', () => {
    const { options, notes } = fixture();
    notes.hold('restart-a', 'alice', 'original');
    const broken = createRestartNotes({ ...options, fs: { ...fs, writeFileSync: () => { throw new Error('disk failure'); } } });
    expect(() => broken.hold('restart-a', 'alice', 'lost')).toThrow('disk failure');
    expect(notes.listHeld('restart-a')[0].text).toBe('original');
  });

  it.each([[null, 'alice', 'text'], ['restart-a', null, 'text'], ['restart-a', 'alice', ''], ['restart-a', 'alice', null]])('refuses invalid note inputs %j', (id, convoId, text) => {
    const { notes } = fixture();
    expect(() => notes.hold(id, convoId, text)).toThrow('Invalid restart note');
  });
});
