// Materialise a tracker item's file attachments on disk for the agent.
//
// An attachment on an item lives in the journal's blob store. The bridge is
// the only party with the agent token, so unless it downloads the file, the
// agent only ever sees the name — and a user who attached a CSV to answer a
// question has to be asked to send it again in chat (2026-09-29, Dan on the
// Yazzoo audit CSV: "can we get that fixed?"). Both readers of an item's
// thread — the 📌 turn (lib/items-turn.js) and item_get (lib/items-tools.js)
// — run their non-audio attachments through the saver this module builds,
// and render the resulting absolute path so the agent can Read it.
//
// Audio is not this module's business: voice notes are transcribed by the
// turn router, and their transcript is what the agent needs.
//
// Everything I/O-shaped is injected (fetchMedia, the target directory, fs)
// so this is unit-testable without a journal or a real home directory. The
// contract is fail-open per attachment: a fetch or write failure leaves that
// attachment as it was (name only), never throws, and never blocks the
// siblings that did download.
import fs from 'node:fs';
import path from 'node:path';

const isAudio = (a) => typeof a?.mime === 'string' && a.mime.startsWith('audio/');

// Make the journal-supplied name safe as a path segment AND as prose: strip
// directory components a malicious/odd name might carry ('.'/'..' and the
// empty case fold into a fallback, same rule as index.js's safeMediaFilename,
// which is not exported), then collapse control characters and whitespace
// runs to one space. The path is interpolated into the 📌 turn, where a line
// starting with 📌 is structure — a name carrying a newline would otherwise
// let a downloaded attachment forge a second marker line (Bugbot, PR 325).
export function safeAttachmentFilename(name, fallback = 'attachment') {
  const base = path.basename(typeof name === 'string' && name ? name : fallback)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ')
    .trim();
  return base === '' || base === '.' || base === '..' ? fallback : base;
}

export function createItemAttachmentSaver({
  // async (blobRef) -> { buffer, contentType } | null. index.js wires
  // journalPublisher.fetchMedia (fails open, never throws, 25 MB cap).
  fetchMedia,
  // (session) -> absolute directory to save into. index.js wires the same
  // choice the chat media path makes: the iv upload dir for a PTY session,
  // ~/matron-files/<repo>/ otherwise — outside the workdir, so a received
  // file never ends up committed.
  dirFor,
  fsImpl = fs,
  log = console,
} = {}) {
  const warn = (msg) => { try { log.warn(msg); } catch { /* logging must never throw */ } };

  // blob_ref -> path already written for it. item_get is called repeatedly
  // on the same thread; without this every call would download every
  // attachment again and litter the directory with -1, -2 copies. Entries
  // are validated against the filesystem at use, so a file the agent deleted
  // is fetched afresh rather than pointed at a hole.
  const written = new Map();
  const remember = (key, value) => {
    written.set(key, value);
    if (written.size > 500) written.delete(written.keys().next().value);
  };

  function freePath(dir, filename) {
    let target = path.join(dir, filename);
    if (!fsImpl.existsSync(target)) return target;
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    for (let i = 1; ; i++) {
      target = path.join(dir, `${base}-${i}${ext}`);
      if (!fsImpl.existsSync(target)) return target;
    }
  }

  // One attachment -> the same object plus `path` when it could be saved.
  async function saveOne(session, a) {
    if (!a || typeof a !== 'object' || isAudio(a)) return a;
    const blobRef = typeof a.blob_ref === 'string' ? a.blob_ref : '';
    if (!blobRef) return a;
    const dir = dirFor(session);
    const key = `${dir}\0${blobRef}`;
    const prior = written.get(key);
    if (prior && fsImpl.existsSync(prior)) return { ...a, path: prior };
    let fetched = null;
    try { fetched = await fetchMedia(blobRef); } catch (e) { warn(`[item-attachments] fetch threw for blob_ref=${blobRef}: ${e?.message ?? e}`); }
    if (!fetched?.buffer) {
      warn(`[item-attachments] fetch returned nothing for blob_ref=${blobRef} — leaving the attachment as a name`);
      return a;
    }
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      const target = freePath(dir, safeAttachmentFilename(a.name));
      fsImpl.writeFileSync(target, fetched.buffer);
      remember(key, target);
      return { ...a, path: target };
    } catch (e) {
      warn(`[item-attachments] could not save blob_ref=${blobRef}: ${e?.message ?? e}`);
      return a;
    }
  }

  // (session, attachments[]) -> a new array, each non-audio attachment
  // carrying `path` when saved. Anything that is not an array comes back
  // as-is, so callers can pass a journal field through blind.
  return async function saveAttachments(session, attachments) {
    if (!Array.isArray(attachments) || !attachments.length) return attachments;
    const out = [];
    for (const a of attachments) out.push(await saveOne(session, a));
    return out;
  };
}
