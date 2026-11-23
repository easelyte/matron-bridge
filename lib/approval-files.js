// Signed taps as files. When the user taps a step-up question, the journal
// keeps the signed approval on the tap comment (`approval`, owner's reads
// only). A command that guards a dangerous action on this box checks that
// approval itself, against its own pinned keys, and takes it as a file:
// `{"statement": "...", "signature": "..."}`, exactly as the journal stored
// it. item_get writes each one it reads to such a file and names the path, so
// the agent can hand it over without copying the statement by hand.
//
// The file is not a secret (a signature over a statement anyone holding a
// token could read) and the agent is not trusted with it: whatever reads it
// verifies the signature. What matters is where it lands:
//
// - Each file is owned by the bridge's own user, the user the agent runs as,
//   so a command run through sudo can check that whoever ran it owns the
//   file it was handed.
// - The directory is /tmp/matron-approvals-<uid> by default, created by this user with mode 0711 and files are
//   0644, so another local user (the command's own) can read a file whose
//   path it is given but cannot list the directory.
// - A directory that already exists must be a real directory owned by this
//   user and not writable by anyone else; otherwise nothing is written. A
//   shared temp directory lets another user create the name first.
// - Without user ids (Windows) nothing is written.
//
// Every failure answers null: item_get then shows the tap without a path.
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic-write.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

// /tmp, not os.tmpdir(): the reader is another local user, so every parent
// must be one it can pass through, and a per-user temp folder (macOS's
// TMPDIR under /var/folders, mode 0700; a TMPDIR set to a private dir)
// would stop it. Where there are no user ids nothing is saved anyway.
export function defaultApprovalFilesDir({ os = nodeOs, uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  const base = typeof uid === 'number' ? '/tmp' : os.tmpdir();
  return path.join(base, `matron-approvals-${uid ?? 'user'}`);
}

export function createApprovalFiles({
  dir = defaultApprovalFilesDir(),
  fs = nodeFs,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  log = console,
} = {}) {
  const warn = (msg) => { try { log.warn(msg); } catch { /* logging must never throw */ } };
  // A platform with no user ids (Windows) has no file modes to rely on
  // either, and no sudo to hand a file across: nothing is saved there.
  if (typeof uid !== 'number') return { dir, save: () => null };

  function ready() {
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch (e) {
      if (e?.code !== 'ENOENT') { warn(`[approval-files] cannot use ${dir}: ${e?.code || e?.message}`); return false; }
      try {
        fs.mkdirSync(dir, { mode: 0o711 });
        st = fs.lstatSync(dir);
      } catch (e2) {
        warn(`[approval-files] cannot create ${dir}: ${e2?.code || e2?.message}`);
        return false;
      }
    }
    if (!st.isDirectory()) { warn(`[approval-files] ${dir} is not a directory`); return false; }
    if (typeof uid === 'number' && st.uid !== uid) { warn(`[approval-files] ${dir} belongs to another user`); return false; }
    if (st.mode & 0o022) { warn(`[approval-files] ${dir} is writable by its group or by everyone`); return false; }
    // mkdir's mode is masked by the umask; set what the files' readers need.
    if ((st.mode & 0o777) !== 0o711) {
      try { fs.chmodSync(dir, 0o711); } catch { /* a stricter mode only hides the files from their reader */ }
    }
    return true;
  }

  // itemNum: the item's #num. comment: the tap comment as the journal
  // returned it. Answers the file's path, or null.
  function save(itemNum, comment) {
    const approval = comment?.approval;
    if (!approval || typeof approval !== 'object' || typeof approval.statement !== 'string' || typeof approval.signature !== 'string') return null;
    if (!Number.isSafeInteger(itemNum) || itemNum < 1) return null;
    const id = typeof comment.id === 'string' && SAFE_ID.test(comment.id) ? comment.id : null;
    if (!id) return null;
    if (!ready()) return null;
    const file = path.join(dir, `item-${itemNum}-${id}.json`);
    try {
      // Exactly the two keys, in the stored strings: the reader refuses
      // anything else, and the signature is over the statement as stored.
      atomicWriteFileSync(file, JSON.stringify({ statement: approval.statement, signature: approval.signature }), { fs, mode: 0o644 });
      return file;
    } catch (e) {
      warn(`[approval-files] could not write ${file}: ${e?.code || e?.message}`);
      return null;
    }
  }

  return { dir, save };
}
