// Resume notes: a session leaves itself a note (reminder_create with
// `restart_note: true`) that the bridge keeps on disk and delivers as that
// conversation's first turn after the NEXT bridge restart.
//
// Delivery goes through the boot carry-on path (carryOnConvo in index.js), so
// this file holds only the parts that must be exactly right and are easy to
// test without a live bridge:
//
//   - the store: one note per conversation (a newer note replaces the older),
//     written atomically with owner-only permissions, size-capped;
//   - take(): read and delete in one step BEFORE anything is delivered, so a
//     note fires at most once even if delivery or the boot crashes;
//   - takeNoteDeliveries(): choose which notes become a turn, and drop the
//     conversations they cover from the stale-marker list BEFORE
//     selectAutoCarryOn runs, so a conversation gets at most one
//     bridge-made first turn per boot (the note replaces both the automatic
//     carry-on and the "Carry on" card).
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic-write.js';

export const NOTE_MAX_CHARS = 2000;
export const NOTE_MAX_COUNT = 50;
// Older than this at boot and the note is dropped: what it says is probably
// no longer true.
export const NOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_NOTES_FILE = path.join(os.homedir(), '.matron-bridge-restart-notes.json');

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const validEntry = (e) => !!e && typeof e === 'object' && nonEmpty(e.convoId) && nonEmpty(e.text)
  && e.text.length <= NOTE_MAX_CHARS && Number.isFinite(e.writtenAt);

export function createRestartNotes({ file = DEFAULT_NOTES_FILE, fs = nodeFs, now = Date.now } = {}) {
  // A missing or unreadable file is "no notes"; the next put rewrites it.
  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter(validEntry) : [];
    } catch {
      return [];
    }
  }

  return {
    // Throws when the note could not be made durable: the caller must tell
    // the agent, which would otherwise rely on a note that is not there.
    put(convoId, text) {
      if (!nonEmpty(convoId)) throw new Error('restart note needs a conversation');
      if (!nonEmpty(text)) throw new Error('restart note text is empty');
      const body = text.trim();
      if (body.length > NOTE_MAX_CHARS) throw new Error(`restart note must be at most ${NOTE_MAX_CHARS} characters`);
      const entries = readAll().filter(e => e.convoId !== convoId);
      entries.push({ convoId, text: body, writtenAt: now() });
      const kept = entries.slice(-NOTE_MAX_COUNT);
      atomicWriteFileSync(file, JSON.stringify(kept), { fs, mode: 0o600 });
      return { convoId, text: body };
    },

    // Fire-once: the file is removed before the notes are returned. If it
    // cannot be removed nothing is returned, because delivering a note that
    // stays on disk would deliver it again on the next boot.
    take() {
      const entries = readAll();
      try {
        fs.unlinkSync(file);
      } catch (e) {
        if (e?.code !== 'ENOENT') return [];
      }
      return entries;
    },
  };
}

// The turn the resumed session receives. `ageMs` is how long ago the note was
// written; the session wrote it, so the text says so. `interrupted` says the
// restart cut a turn off mid-way, which the note replaces the carry-on for.
export function restartNoteTurnText(text, ageMs, frameSafe = (s) => s, interrupted = false) {
  const mins = Math.max(1, Math.round(ageMs / 60_000));
  const ago = mins >= 120 ? `${Math.round(mins / 60)} hours` : mins >= 60 ? 'about an hour' : `${mins} min`;
  const cut = interrupted ? ' It cut your turn off mid-way: check what finished before you carry on.' : '';
  return `[restart note] The bridge restarted.${cut} You left yourself this note ${ago} before it: ${frameSafe(String(text))}`;
}

// Take the notes (deleting them) and decide which to deliver.
//
// A note is delivered only to a conversation that is resumable (a persisted,
// therefore not archived or closed, session), within NOTE_MAX_AGE_MS, and not
// cut off mid-turn by another person's message: that turn keeps its card,
// which names whose it was. Every conversation that gets a note is removed
// from `stale`, so the caller's auto carry-on and card paths skip it.
//
// -> { deliveries: [{ convoId, text, ageMs, interrupted }], stale: <stale minus noted> }
//    interrupted: the conversation was on `stale` (cut off mid-turn).
export function takeNoteDeliveries({
  store, stale = [], resumable, isResumeConvoId = () => true,
  now = Date.now, maxAgeMs = NOTE_MAX_AGE_MS, log = () => {},
}) {
  const foreign = new Set(stale.filter(r => r?.foreignPerson).map(r => r.convoId));
  const cutOff = new Set(stale.map(r => r?.convoId));
  const latest = new Map();
  for (const note of store.take()) {
    const prior = latest.get(note.convoId);
    if (!prior || note.writtenAt >= prior.writtenAt) latest.set(note.convoId, note);
  }
  const t = now();
  const deliveries = [];
  for (const note of latest.values()) {
    const ageMs = t - note.writtenAt;
    let drop = null;
    if (ageMs > maxAgeMs) drop = 'too old';
    else if (!resumable.has(note.convoId) || !isResumeConvoId(note.convoId)) drop = 'not resumable';
    else if (foreign.has(note.convoId)) drop = 'interrupted turn belongs to another person';
    if (drop) {
      log(`[restart-note] dropped note for convo=${note.convoId}: ${drop}`);
      continue;
    }
    deliveries.push({ convoId: note.convoId, text: note.text, ageMs: Math.max(0, ageMs), interrupted: cutOff.has(note.convoId) });
  }
  const noted = new Set(deliveries.map(d => d.convoId));
  return { deliveries, stale: stale.filter(r => !noted.has(r?.convoId)) };
}
