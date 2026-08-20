// Guarded, atomic edit of an EXISTING file inside a pinned allowed root.
//
// Backend slice of loop #548 — lets a journal client apply a small file edit
// (add a gitignored env var, tweak a config) while the operator is on the
// bridge with no SSH/VSCode. The client-facing affordance is a SEPARATE piece
// of work; this module + its RPC method are the guarded backend the client
// wires to later.
//
// This composes the two existing primitives rather than reinventing either:
//   - lib/file-link-guard.js `validateAndOpen` is THE path-safety boundary and
//     is reused verbatim: it opens the target O_NOFOLLOW (a symlink final
//     component fails ELOOP), resolves the fd's REAL path via /proc/self/fd
//     (immune to path swaps after open), then enforces containment in the
//     pinned allowed roots + non-sensitivity + is-a-regular-file + size. We do
//     NOT add a second denylist or traversal check — the write targets the
//     already-proven-in-scope real path it returns. It also hands back the
//     current bytes, which the targeted-edit mode needs.
//   - lib/atomic-write.js `atomicWriteFileSync` writes a temp sibling then
//     renames, so a kill / power loss / short write mid-edit never corrupts or
//     truncates the target (the original stays intact on any failure).
//
// Scope is deliberately EXISTING files only. Creating a new file needs a
// parent-directory validation path `validateAndOpen` doesn't provide (it opens
// the target itself for read); that is out of scope for this slice and would
// need its own guarded-create primitive.

import { createHash } from 'node:crypto';
import { statSync, chmodSync } from 'node:fs';
import { validateAndOpen, FileLinkDenied } from './file-link-guard.js';
import { atomicWriteFileSync } from './atomic-write.js';

// Bound the post-edit result. Config tweaks and env lines are tiny; this only
// exists so a full-content replace can't be used to write an unbounded blob.
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

// Structured, fail-loud error. `.code` is the wire error code the RPC layer
// surfaces; for path rejections it is the guard's own reason verbatim
// (relative-path / symlink / outside-scope / sensitive / not-a-file /
// too-large / unreadable / bad-workdir) so the caller can tell escapes apart.
export class EditFileError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'EditFileError';
    this.code = code;
    this.detail = detail;
  }
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

// applyFileEdit(input, opts) -> { path, bytes, mode }
//   input.path        absolute path to an existing file inside the pinned roots
//   input.content     full-content replacement (string)          -- mode "content"
//   input.old_string  unique substring to replace (non-empty)    -- mode "replace"
//   input.new_string  its literal replacement (string)           -- mode "replace"
//   input.expected_sha256  OPTIONAL compare-and-swap precondition: the sha256
//     (hex) the caller believes the file currently holds. When present the edit
//     applies ONLY if the live content still hashes to it, else -> "stale".
//     This is how a client makes a lost-response retry or a concurrent edit
//     safe (read -> hash -> edit-with-expected); absent = no precondition.
// Exactly one of { content } / { old_string (+ new_string) } is required.
// Throws EditFileError for every rejection; unexpected errors propagate raw.
export async function applyFileEdit(input, {
  allowedRoots,
  maxBytes = MAX_EDIT_BYTES,
  deps = { validateAndOpen, FileLinkDenied, atomicWrite: atomicWriteFileSync },
} = {}) {
  const params = input && typeof input === 'object' ? input : {};

  const filePath = params.path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new EditFileError('bad_request', 'path must be a non-empty string');
  }

  // Exclusive, fail-loud mode selection. Both or neither is malformed.
  const hasContent = Object.prototype.hasOwnProperty.call(params, 'content');
  const hasOld = Object.prototype.hasOwnProperty.call(params, 'old_string');
  if (hasContent && hasOld) {
    throw new EditFileError('bad_request', 'supply either content or old_string, not both');
  }
  if (!hasContent && !hasOld) {
    throw new EditFileError('bad_request', 'one of content or old_string is required');
  }
  if (hasContent && typeof params.content !== 'string') {
    throw new EditFileError('bad_request', 'content must be a string');
  }
  if (hasOld) {
    if (typeof params.old_string !== 'string' || params.old_string.length === 0) {
      throw new EditFileError('bad_request', 'old_string must be a non-empty string');
    }
    if (typeof params.new_string !== 'string') {
      throw new EditFileError('bad_request', 'new_string must be a string');
    }
  }
  const hasExpected = Object.prototype.hasOwnProperty.call(params, 'expected_sha256');
  if (hasExpected && (typeof params.expected_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(params.expected_sha256))) {
    throw new EditFileError('bad_request', 'expected_sha256 must be a 64-char hex digest');
  }

  // Fail CLOSED if scope was never established. validateAndOpen only enforces
  // containment when the pinned root set is non-empty; an empty/absent set
  // would let this write anywhere readable. Mirror shareAgentMedia's guard.
  if (!Array.isArray(allowedRoots?.roots) || allowedRoots.roots.length === 0) {
    throw new EditFileError('bad_workdir', 'no allowed roots pinned');
  }

  // The path-safety boundary AND our read of the current bytes, in one
  // fd-pinned step. `realPath` is the symlink-resolved, proven-in-scope path we
  // then write to — never the caller's original string. strictSnapshot: an
  // edit must start from a whole, coherent file, not a torn read.
  let current;
  let realPath;
  try {
    ({ content: current, realPath } = await deps.validateAndOpen(filePath, {
      allowedRoots,
      maxBytes,
      strictSnapshot: true,
    }));
  } catch (e) {
    if (e instanceof deps.FileLinkDenied) {
      throw new EditFileError(e.reason, `path rejected: ${e.reason}`);
    }
    throw e;
  }

  // Compare-and-swap precondition (optional). Reject if the live content no
  // longer matches what the caller based its edit on — this is what makes a
  // lost-response retry or a concurrent edit safe (a replayed old->new edit
  // would otherwise re-apply, and two racing edits would lose the first write).
  if (hasExpected) {
    const actual = createHash('sha256').update(current).digest('hex');
    if (actual.toLowerCase() !== params.expected_sha256.toLowerCase()) {
      throw new EditFileError('stale', 'file no longer matches expected_sha256');
    }
  }

  let next;
  if (hasContent) {
    next = params.content;
  } else {
    const before = current.toString('utf8');
    const occurrences = countOccurrences(before, params.old_string);
    if (occurrences === 0) {
      throw new EditFileError('not_found', 'old_string not present in file');
    }
    if (occurrences > 1) {
      throw new EditFileError('ambiguous_match', `old_string occurs ${occurrences} times; must be unique`);
    }
    // Literal splice (indexOf + slice) — NOT String.replace, which would
    // interpret $&, $1, ${...} sequences in new_string.
    const idx = before.indexOf(params.old_string);
    next = before.slice(0, idx) + params.new_string + before.slice(idx + params.old_string.length);
  }

  const nextBytes = Buffer.byteLength(next, 'utf8');
  if (nextBytes > maxBytes) {
    throw new EditFileError('too_large', `result ${nextBytes} exceeds ${maxBytes} bytes`);
  }

  // Preserve the target's permission bits. atomicWriteFileSync replaces the
  // target with a freshly created inode, which would otherwise take default
  // umask perms — silently loosening a 0600 secret to 0644 or stripping +x
  // from a 0700 script. Capture before the write, re-apply after (chmod is not
  // umask-masked, so it restores setuid/setgid/sticky + rwx exactly). Owner is
  // preserved implicitly: the bridge process recreates the file as the same
  // uid. statSync on the validated realPath (final component already proven
  // symlink-free by validateAndOpen's O_NOFOLLOW) is best-effort.
  let priorMode;
  try { priorMode = statSync(realPath).mode & 0o7777; } catch { priorMode = undefined; }

  // NOTE (accepted residual, consistent with file-link-guard's own posture):
  // validateAndOpen is fd-pinned, but atomicWriteFileSync commits through the
  // resolved PATHNAME, so a hostile local process that renames a PARENT
  // directory between validation and the temp-write+rename could redirect the
  // write. Pure Node exposes no openat/renameat to hold a directory capability
  // across the commit, and file-link-guard.js accepts this same parent-swap
  // window on the single-user Linux deployment (see its lines 165-173). It
  // requires a second local principal with write access to a pinned-root
  // parent, which is outside this box's single-user threat model. Documented,
  // not silently ignored; revisit if a guarded-write openat primitive lands.
  deps.atomicWrite(realPath, next);
  if (priorMode !== undefined) {
    try { chmodSync(realPath, priorMode); } catch { /* best-effort perm restore */ }
  }
  return { path: realPath, bytes: nextBytes, mode: hasContent ? 'content' : 'replace' };
}
