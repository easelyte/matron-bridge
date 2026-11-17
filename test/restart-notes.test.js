import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRestartNotes, takeNoteDeliveries, restartNoteTurnText, NOTE_MAX_CHARS, NOTE_MAX_AGE_MS,
} from '../lib/restart-notes.js';
import { selectAutoCarryOn } from '../lib/code-update-restart.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-notes-'));
  return { dir, file: path.join(dir, 'notes.json') };
}

// A fs whose named methods are replaced; everything else is the real module.
function fsWith(overrides) {
  return new Proxy(fs, { get: (target, prop) => (prop in overrides ? overrides[prop] : target[prop]) });
}

describe('restart note store', () => {
  it('keeps one note per conversation; a newer note replaces the older', () => {
    const { file } = tmpFile();
    const store = createRestartNotes({ file, now: () => NOW });
    store.put('c1', 'first');
    store.put('c2', 'other chat');
    store.put('c1', 'second');
    const notes = store.take();
    expect(notes.filter(n => n.convoId === 'c1').map(n => n.text)).toEqual(['second']);
    expect(notes.find(n => n.convoId === 'c2').text).toBe('other chat');
  });

  it('writes atomically (temp file then rename) with owner-only permissions', () => {
    const { file } = tmpFile();
    const calls = [];
    const spy = fsWith({ renameSync: (a, b) => { calls.push([a, b]); return fs.renameSync(a, b); } });
    createRestartNotes({ file, fs: spy, now: () => NOW }).put('c1', 'hello');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).not.toBe(file);
    expect(calls[0][1]).toBe(file);
    // POSIX permission bits don't exist on Windows.
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('throws when the write fails and leaves the earlier note intact', () => {
    const { file } = tmpFile();
    createRestartNotes({ file, now: () => NOW }).put('c1', 'keep me');
    const failing = fsWith({ renameSync: () => { throw new Error('ENOSPC'); } });
    const store = createRestartNotes({ file, fs: failing, now: () => NOW });
    expect(() => store.put('c1', 'lost')).toThrow(/ENOSPC/);
    expect(createRestartNotes({ file }).take().map(n => n.text)).toEqual(['keep me']);
  });

  it('caps note size', () => {
    const { file } = tmpFile();
    const store = createRestartNotes({ file, now: () => NOW });
    expect(() => store.put('c1', 'x'.repeat(NOTE_MAX_CHARS + 1))).toThrow(/at most/);
    expect(() => store.put('c1', '   ')).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('take() deletes the file before returning, so a note fires once', () => {
    const { file } = tmpFile();
    const store = createRestartNotes({ file, now: () => NOW });
    store.put('c1', 'once');
    const first = store.take();
    expect(fs.existsSync(file)).toBe(false);
    expect(first).toHaveLength(1);
    expect(store.take()).toEqual([]);
  });

  it('take() returns nothing when the file cannot be deleted', () => {
    const { file } = tmpFile();
    createRestartNotes({ file, now: () => NOW }).put('c1', 'stuck');
    const stuck = fsWith({ unlinkSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } });
    expect(createRestartNotes({ file, fs: stuck }).take()).toEqual([]);
  });
});

describe('takeNoteDeliveries', () => {
  const setup = (notes) => {
    const { file } = tmpFile();
    const store = createRestartNotes({ file, now: () => NOW - 10 * MIN });
    for (const [convoId, text] of notes) store.put(convoId, text);
    return store;
  };
  const resumable = new Set(['c1', 'c2', 'c3']);

  it('delivers to a resumable conversation and drops it from the stale list before the carry-on split', () => {
    const store = setup([['c1', 'finish the deploy check']]);
    const stamp = { bootId: 'b1' };
    const stale = [{ convoId: 'c1', bootId: 'b1', ageMs: 5 }, { convoId: 'c2', bootId: 'b1', ageMs: 5 }];
    const r = takeNoteDeliveries({ store, stale, resumable, now: () => NOW });
    expect(r.deliveries).toEqual([{ convoId: 'c1', text: 'finish the deploy check', ageMs: 10 * MIN, interrupted: true }]);
    const { auto, card } = selectAutoCarryOn(r.stale, stamp, { enabled: true });
    const firstTurns = [...r.deliveries.map(d => d.convoId), ...auto.map(a => a.convoId), ...card.map(c => c.convoId)];
    expect(firstTurns.filter(id => id === 'c1')).toHaveLength(1);
    expect(auto.map(a => a.convoId)).toEqual(['c2']);
  });

  it('without a note the stale conversation still goes through the carry-on split', () => {
    const store = setup([]);
    const stale = [{ convoId: 'c1', bootId: 'b1' }];
    const r = takeNoteDeliveries({ store, stale, resumable, now: () => NOW });
    expect(r.deliveries).toEqual([]);
    expect(r.stale).toEqual(stale);
  });

  it('delivers a note even when no turn was interrupted', () => {
    const store = setup([['c3', 'idle note']]);
    const r = takeNoteDeliveries({ store, stale: [], resumable, now: () => NOW });
    expect(r.deliveries.map(d => d.convoId)).toEqual(['c3']);
    expect(r.deliveries[0].interrupted).toBe(false);
  });

  it('deletes the notes before returning them', () => {
    const { file } = tmpFile();
    createRestartNotes({ file, now: () => NOW - MIN }).put('c1', 'a');
    const store = createRestartNotes({ file });
    let onDiskWhenReturned = null;
    const spy = { take: () => { const n = store.take(); onDiskWhenReturned = fs.existsSync(file); return n; } };
    const r = takeNoteDeliveries({ store: spy, stale: [], resumable, now: () => NOW });
    expect(onDiskWhenReturned).toBe(false);
    expect(r.deliveries).toHaveLength(1);
    expect(store.take()).toEqual([]);
  });

  it('drops notes for conversations that are not resumable (archived or gone)', () => {
    const store = setup([['gone', 'x']]);
    const r = takeNoteDeliveries({ store, stale: [], resumable, now: () => NOW });
    expect(r.deliveries).toEqual([]);
  });

  it('drops notes older than the age cap', () => {
    const store = setup([['c1', 'stale news']]);
    const r = takeNoteDeliveries({ store, stale: [], resumable, now: () => NOW - 10 * MIN + NOTE_MAX_AGE_MS + 1 });
    expect(r.deliveries).toEqual([]);
  });

  it('never delivers to a turn another person started; that turn keeps its card', () => {
    const store = setup([['c1', 'x']]);
    const stale = [{ convoId: 'c1', bootId: 'b1', foreignPerson: 'Sam' }];
    const r = takeNoteDeliveries({ store, stale, resumable, now: () => NOW });
    expect(r.deliveries).toEqual([]);
    expect(r.stale).toEqual(stale);
  });

  it('collapses duplicate notes for one conversation to the newest', () => {
    const spy = { take: () => [
      { convoId: 'c1', text: 'old', writtenAt: NOW - 30 * MIN },
      { convoId: 'c1', text: 'new', writtenAt: NOW - 5 * MIN },
    ] };
    const r = takeNoteDeliveries({ store: spy, stale: [], resumable, now: () => NOW });
    expect(r.deliveries.map(d => d.text)).toEqual(['new']);
  });
});

describe('restartNoteTurnText', () => {
  it('says the bridge restarted and quotes the note through the frame filter', () => {
    const t = restartNoteTurnText('line', 10 * MIN, (s) => `<${s}>`);
    expect(t).toContain('The bridge restarted');
    expect(t).toContain('10 min');
    expect(t).toContain('<line>');
    expect(t).not.toContain('cut your turn off');
  });

  it('says a turn was cut off when the chat was interrupted', () => {
    expect(restartNoteTurnText('line', 10 * MIN, undefined, true)).toContain('It cut your turn off mid-way');
  });
});

describe('peek and discard (fork: the two halves of take)', () => {
  it('peek reads without removing; discard removes, and is quiet when the file is already gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-peek-'));
    try {
      const store = createRestartNotes({ file: path.join(dir, 'notes.json') });
      store.put('c1', 'first');
      expect(store.peek()).toMatchObject([{ convoId: 'c1', text: 'first' }]);
      expect(store.peek()).toHaveLength(1);
      store.discard();
      expect(store.peek()).toEqual([]);
      expect(() => store.discard()).not.toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
