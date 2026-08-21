// Guarded read of an EXISTING file inside a pinned allowed root.
//
// Read counterpart of lib/edit-file.js (loop #548). The in-client editor
// authors whole-file content, and edit_file's `expected_sha256` CAS is the only
// replay/concurrency guard it has — but a client can't compute that sha without
// first reading the file's exact bytes. This module is that read: given an
// allowed path it returns the current content + a sha256 over the exact bytes +
// size + permission mode, so the editor can load-then-edit and auto-fill the
// CAS (making it protective by default instead of opt-in-and-unusable).
//
// It REUSES the identical path-safety boundary edit_file uses — no second
// denylist, no independent traversal check:
//   - lib/file-link-guard.js `validateAndOpen` opens the target O_NOFOLLOW (a
//     symlink final component fails ELOOP), resolves the fd's REAL path via
//     /proc/self/fd (immune to path swaps after open), then enforces
//     containment in the pinned allowed roots + non-sensitivity + is-a-regular
//     -file + size, and hands back the bounded snapshot bytes. We read
//     strictSnapshot: true — the SAME mode edit_file reads its pre-edit
//     snapshot in — so the sha256 we hash is over exactly the bytes edit_file's
//     CAS will re-hash and compare against. A round-trip (read -> edit with the
//     returned sha) therefore satisfies the CAS on an unchanged file.
//
// Read-only: it never writes, so it needs neither atomic-write nor the perm
// -preservation dance edit-file.js does.

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { validateAndOpen, FileLinkDenied } from './file-link-guard.js';

// Mirror edit-file.js's MAX_EDIT_BYTES: the read cap must be at least as large
// as the edit cap, or a file editable in place could not be loaded to author
// the edit. Same 5 MiB bound.
export const MAX_READ_BYTES = 5 * 1024 * 1024;

// Structured, fail-loud error. `.code` is the wire error code the RPC layer
// surfaces. Path rejections carry the guard's own reason verbatim
// (relative-path / symlink / outside-scope / sensitive / not-a-file /
// unreadable / bad-workdir) so read_file and edit_file share ONE vocabulary;
// the one exception is the size limit, normalized from the guard's 'too-large'
// to the underscored own-code `too_large` (the canonical size code, alongside
// bad_workdir / bad_request).
export class ReadFileError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ReadFileError';
    this.code = code;
    this.detail = detail;
  }
}

// readFileGuarded(input, opts) -> { path, content, sha256, bytes, mode }
//   input.path   absolute path to an existing file inside the pinned roots
//   returns:
//     path     the symlink-resolved, proven-in-scope real path (never the
//              caller's original string)
//     content  the file bytes decoded as utf8 (the editor loads this into the
//              textarea; whole-file save round-trips through edit_file.content)
//     sha256   hex digest over the EXACT bytes read — the value to hand
//              edit_file as expected_sha256 for an on-by-default CAS
//     bytes    byte length of the snapshot
//     mode     permission bits (octal number, & 0o7777); undefined if unstatable
// Throws ReadFileError for every rejection; unexpected errors propagate raw.
export async function readFileGuarded(input, {
  allowedRoots,
  maxBytes = MAX_READ_BYTES,
  deps = { validateAndOpen, FileLinkDenied },
} = {}) {
  const params = input && typeof input === 'object' ? input : {};

  const filePath = params.path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new ReadFileError('bad_request', 'path must be a non-empty string');
  }

  // Fail CLOSED if scope was never established — mirror edit-file.js exactly.
  // validateAndOpen only enforces containment when the pinned root set is
  // non-empty; an empty/absent set would let this read anything readable.
  if (!Array.isArray(allowedRoots?.roots) || allowedRoots.roots.length === 0) {
    throw new ReadFileError('bad_workdir', 'no allowed roots pinned');
  }

  // The path-safety boundary AND the fd-pinned read of the current bytes, in
  // one step. `realPath` is the symlink-resolved, proven-in-scope path.
  // strictSnapshot: true matches edit_file's pre-edit read — a torn/racing read
  // throws 'unreadable' rather than hashing an incoherent buffer.
  let content;
  let realPath;
  try {
    ({ content, realPath } = await deps.validateAndOpen(filePath, {
      allowedRoots,
      maxBytes,
      strictSnapshot: true,
    }));
  } catch (e) {
    if (e instanceof deps.FileLinkDenied) {
      const code = e.reason === 'too-large' ? 'too_large' : e.reason;
      throw new ReadFileError(code, `path rejected: ${e.reason}`);
    }
    throw e;
  }

  // sha256 over the exact bytes validateAndOpen returned — the SAME Buffer
  // edit_file's CAS hashes (createHash('sha256').update(current)), so the
  // digest round-trips through expected_sha256.
  const sha256 = createHash('sha256').update(content).digest('hex');

  // Permission bits, for parity with edit-file.js's perm-preservation read.
  // statSync on the validated realPath (final component already proven
  // symlink-free by validateAndOpen's O_NOFOLLOW) is best-effort.
  let mode;
  try { mode = statSync(realPath).mode & 0o7777; } catch { mode = undefined; }

  return {
    path: realPath,
    content: content.toString('utf8'),
    sha256,
    bytes: content.length,
    mode,
  };
}
