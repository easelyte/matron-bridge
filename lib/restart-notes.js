import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic-write.js';

const text = value => typeof value === 'string' && value.trim().length > 0;
const key = entry => JSON.stringify([entry.id, entry.convoId]);

export function createRestartNotes({
  fs = nodeFs,
  heldFile = path.join(os.homedir(), '.matron-bridge-restart-notes.json'),
  pendingFile = path.join(os.homedir(), '.matron-bridge-restart-pending.json'),
  now = Date.now,
} = {}) {
  function read(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.some(entry => !entry || !text(entry.id)
      || !text(entry.convoId) || !text(entry.text) || !Number.isFinite(entry.writtenAt))
      || new Set(entries.map(key)).size !== entries.length) throw new Error('Invalid restart notes');
    return entries;
  }
  const save = (file, entries) => atomicWriteFileSync(file, JSON.stringify(entries), { fs, mode: 0o600 });

  return {
    listHeld: id => read(heldFile).filter(entry => entry.id === id),
    listPending: id => read(pendingFile).filter(entry => id === undefined || entry.id === id),

    putPending(entry) {
      if (!entry || !text(entry.id) || !text(entry.convoId) || !text(entry.text)
        || !Number.isFinite(entry.writtenAt)) throw new Error('Invalid restart note');
      const entries = read(pendingFile);
      const index = entries.findIndex(prior => key(prior) === key(entry));
      if (index === -1) entries.push(entry);
      else entries[index] = entry;
      save(pendingFile, entries);
    },

    removePending(id, convoId) {
      if (!text(id) || !text(convoId)) throw new Error('Invalid restart note');
      save(pendingFile, read(pendingFile).filter(entry => entry.id !== id || entry.convoId !== convoId));
    },

    removeHeld(id, convoId) {
      if (!text(id) || !text(convoId)) throw new Error('Invalid restart note');
      save(heldFile, read(heldFile).filter(entry => entry.id !== id || entry.convoId !== convoId));
    },

    hold(id, convoId, note) {
      if (!text(id) || !text(convoId) || !text(note)) throw new Error('Invalid restart note');
      const entries = read(heldFile);
      const entry = { id, convoId, text: note, writtenAt: now() };
      const index = entries.findIndex(prior => key(prior) === key(entry));
      if (index === -1) entries.push(entry);
      else entries[index] = entry;
      save(heldFile, entries);
      return entry;
    },

    moveToPending(id) {
      if (!text(id)) throw new Error('Invalid restart note id');
      const held = read(heldFile);
      const pending = read(pendingFile);
      const moving = held.filter(entry => entry.id === id);
      if (!moving.length) return pending.filter(entry => entry.id === id);
      const merged = new Map(pending.map(entry => [key(entry), entry]));
      for (const entry of moving) if (!merged.has(key(entry))) merged.set(key(entry), entry);
      // Commit the destination before clearing the source. A crash between
      // writes leaves both copies; retry merges by key without redelivery.
      save(pendingFile, [...merged.values()]);
      save(heldFile, held.filter(entry => entry.id !== id));
      return [...merged.values()].filter(entry => entry.id === id);
    },
  };
}
