// Gates the viewer links the bridge posts for files Claude writes/edits
// (spec: docs/superpowers/specs/2026-07-14-file-link-hardening-design.md).
// Denylist + scoping adapted from PR #54. Two layers:
//   - checkFileLink: cheap sync gate at link GENERATION (tool_use time; the
//     Write target may not exist yet, so containment is lexical) — UX so we
//     don't post links that will 404, not the security boundary.
//   - validateAndOpen: the serve-time boundary in the viewer — fd-pinned so
//     nothing can change between validation and read (Linux /proc/self/fd,
//     like the rest of this deployment).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MAX_VIEW_BYTES = 5 * 1024 * 1024;
// /download serves whole artifacts (app bundles, archives) rather than
// rendering text, so it gets a larger — but still bounded — budget.
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

// Basename patterns: PR #54 verbatim plus ^secrets?$ added in review. config.json
// is deliberate: this ecosystem's config.json files hold tokens
// (~/.claude-matrix-config.json). Patterns apply to every path segment (directories
// with sensitive-shaped names deny their contents). Path patterns: original five
// dot-dirs from PR #54 verbatim, plus directory-segment patterns added in review
// to flag files inside sensitive directories (e.g., .env/apikey.dat, secrets/db.dat).
// Basename patterns vs. explicit SENSITIVE_PATH_PATTERNS are kept for
// readability/defense-in-depth even where the per-segment rule overlaps.
const SENSITIVE_BASENAME_PATTERNS = [
  /\.env(\..*)?$/i,
  /secrets?\.(json|ya?ml|toml|txt)$/i,
  /^secrets?$/i,
  /^credentials$/i,
  /credentials?\.(json|ya?ml|toml|txt)$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /id_rsa|id_ed25519|id_ecdsa/i,
  /\.npmrc$/i,
  /\.netrc$/i,
  /token(s)?\.(json|txt)$/i,
  /service[-_]?account.*\.json$/i,
  /\.htpasswd$/i,
  /^config\.json$/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /\/\.aws\//i,
  /\/\.docker\//i,
  /\/\.kube\//i,
  /\/\.ssh\//i,
  /\/\.gnupg\//i,
  /\/\.env(\.[^/]*)?\//i,
  /\/secrets?\//i,
  /\/credentials?\//i,
];

export function isSensitivePath(filePath) {
  const segments = String(filePath).split(path.sep).filter(Boolean);
  if (segments.some((seg) => SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(seg)))) return true;
  if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath))) return true;
  return false;
}

// Path-boundary-safe containment: /a/b contains /a/b and /a/b/c, not /a/bc.
// The filesystem root contains everything (parent + sep would test '//').
function contains(parent, child) {
  if (parent === path.sep) return true;
  return child === parent || child.startsWith(parent + path.sep);
}

export function checkFileLink(filePath, workdir) {
  if (!path.isAbsolute(String(filePath))) return { ok: false, reason: 'relative-path' };
  const resolved = path.resolve(filePath);
  if (isSensitivePath(resolved)) return { ok: false, reason: 'sensitive' };
  if (workdir && !contains(path.resolve(workdir), resolved)) {
    return { ok: false, reason: 'outside-workdir' };
  }
  return { ok: true };
}

export class FileLinkDenied extends Error {
  constructor(reason) {
    super(`file link denied: ${reason}`);
    this.name = 'FileLinkDenied';
    this.reason = reason;
  }
}

const PINNED_ROOTS = Symbol('pinned-file-link-roots');

// Resolve authorization roots once, at the trusted boundary, and retain the
// filesystem identities that were approved. Callers must keep and reuse the
// returned value rather than rebuilding it from agent-controlled path names.
export async function pinAllowedRoots(allowedRoots) {
  const roots = [];
  for (const root of allowedRoots || []) {
    try {
      const realPath = await fsp.realpath(root);
      const stat = await fsp.stat(realPath);
      if (!stat.isDirectory()) throw new Error('not a directory');
      roots.push(Object.freeze({ realPath, dev: stat.dev, ino: stat.ino }));
    } catch {
      throw new FileLinkDenied('bad-workdir');
    }
  }
  return Object.freeze({ [PINNED_ROOTS]: true, roots: Object.freeze(roots) });
}

// Session creation is synchronous, so the egress capability needs a matching
// synchronous pinning path. This must run before the agent process is spawned:
// resolving these pathnames later would let the agent replace them first.
export function pinAllowedRootsSync(allowedRoots) {
  const roots = [];
  for (const root of allowedRoots || []) {
    try {
      const realPath = fs.realpathSync(root);
      const stat = fs.statSync(realPath);
      if (!stat.isDirectory()) throw new Error('not a directory');
      roots.push(Object.freeze({ realPath, dev: stat.dev, ino: stat.ino }));
    } catch {
      throw new FileLinkDenied('bad-workdir');
    }
  }
  return Object.freeze({ [PINNED_ROOTS]: true, roots: Object.freeze(roots) });
}

// Resolve the real path of the file an open descriptor is holding.
//
// Linux: /proc/self/fd/N is the kernel's own answer. It is derived from the
// descriptor, not from a pathname walk, so nothing an attacker does to the
// path after open() can change it. This is the branch this deployment runs.
//
// Everywhere else (macOS): there is no procfs and Node exposes neither the
// *at() syscall family nor fcntl(F_GETPATH), so the only way to name the file
// is to re-resolve the pathname — and that re-walk is racy. O_NOFOLLOW only
// protects the FINAL component, so a PARENT directory swapped between open()
// and realpath() makes the guard check sensitivity and containment against a
// pathname that is not the file it is about to read: the descriptor holds the
// attacker's target while the resolved name looks in-scope.
//
// The pathname alone is therefore not trusted. It is accepted only after the
// resolved name is PROVEN to still refer to this descriptor, by comparing the
// resolved name's dev/ino against the descriptor's own stat. lstat (not stat)
// is deliberate: realpath() returns a symlink-free name, so if the final
// component has since become a symlink the inode will not match and we deny —
// the fail-closed direction.
//
// RESIDUAL, not closable in Node today: the identity check proves the name
// referred to this descriptor at the instant of the lstat, not across the
// whole open->read window, and an inode reachable under two names (a hardlink
// planted inside the allowed scope) satisfies it. Closing it fully needs
// openat()/O_PATH path pinning or fcntl(F_GETPATH). What remains is a window
// measured in one syscall rather than an unchecked pathname, and the attacker
// must additionally make the in-scope name resolve to the very inode being
// served. Linux takes the procfs branch and is unaffected by any of this.
export async function fdRealPath(fd, resolvedPath, fdStat, platform = process.platform) {
  if (platform === 'linux') return fsp.readlink(`/proc/self/fd/${fd.fd}`);
  let realPath;
  try {
    realPath = await fsp.realpath(resolvedPath);
  } catch {
    throw new FileLinkDenied('unreadable');
  }
  let nameStat;
  try {
    nameStat = await fsp.lstat(realPath);
  } catch {
    throw new FileLinkDenied('unreadable');
  }
  if (nameStat.dev !== fdStat.dev || nameStat.ino !== fdStat.ino) {
    throw new FileLinkDenied('path-race');
  }
  return realPath;
}

// Serve-time boundary. Opens with O_NOFOLLOW (a symlink final component
// fails with ELOOP), resolves the fd's REAL path via fdRealPath (procfs on
// Linux, identity-checked realpath elsewhere — see above), then re-checks
// sensitivity, containment, type, and size before reading THROUGH THE FD. Throws FileLinkDenied for every rejection it
// detects; an unexpected system error (procfs missing, EIO) propagates raw —
// callers must 404 on ANY throw, not just FileLinkDenied.
//
// `strictSnapshot` controls what happens when the file changes size between
// the stat-time snapshot and read completion (a growing or torn file):
//   - strictSnapshot: true  — the show_file publish path. A size mismatch or
//     an early EOF throws 'unreadable': a published artifact must be a whole,
//     coherent file, never a torn partial.
//   - strictSnapshot: false (DEFAULT) — the /view + /download serve paths.
//     A growing/shrinking file is served as the BOUNDED snapshot of whatever
//     was actually read (never a 404), preserving the pre-hardening behaviour
//     of serving a live-tailing file.
export async function validateAndOpen(filePath, { workdir, allowedRoots, maxBytes = MAX_VIEW_BYTES, strictSnapshot = false } = {}) {
  let fd;
  try {
    if (!path.isAbsolute(String(filePath))) throw new FileLinkDenied('relative-path');
    const pinnedRoots = allowedRoots?.[PINNED_ROOTS] === true ? allowedRoots.roots : [];
    // Preserve the prior empty-array behavior (fall back to workdir), but do
    // not accept unresolved root strings as an authorization boundary.
    if (allowedRoots && (!Array.isArray(allowedRoots) || allowedRoots.length !== 0)
        && allowedRoots[PINNED_ROOTS] !== true) {
      throw new FileLinkDenied('bad-workdir');
    }
    try {
      fd = await fsp.open(
        path.resolve(filePath),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (err) {
      throw new FileLinkDenied(err.code === 'ELOOP' ? 'symlink' : 'unreadable');
    }
    // O_NONBLOCK prevents attacker-created FIFOs from wedging open(). Check
    // the descriptor before any further path work so all special files are
    // rejected without attempting to read them.
    const stat = await fd.stat();
    if (!stat.isFile()) throw new FileLinkDenied('not-a-file');
    // Resolve the REAL path this descriptor holds. Linux answers from procfs;
    // other platforms re-resolve the pathname and must prove it still names
    // this descriptor (see fdRealPath). Do it BEFORE any of the sensitivity /
    // containment / size checks below, so every one of them judges the file
    // the fd actually holds rather than a name that may have been swapped.
    const realPath = await fdRealPath(fd, path.resolve(filePath), stat);
    if (pinnedRoots.length) {
      for (const root of pinnedRoots) {
        try {
          const current = await fsp.stat(root.realPath);
          if (!current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino) {
            throw new Error('root identity changed');
          }
        } catch {
          throw new FileLinkDenied('bad-workdir');
        }
      }
      if (!pinnedRoots.some((root) => contains(root.realPath, realPath))) {
        throw new FileLinkDenied('outside-scope');
      }
    }
    if (isSensitivePath(realPath)) throw new FileLinkDenied('sensitive');
    if (!pinnedRoots.length && workdir) {
      let realWorkdir;
      try {
        realWorkdir = await fsp.realpath(workdir);
      } catch {
        throw new FileLinkDenied('bad-workdir');
      }
      if (!contains(realWorkdir, realPath)) throw new FileLinkDenied('outside-workdir');
    }
    if (stat.size > maxBytes) throw new FileLinkDenied('too-large');
    // Bounded read: allocate exactly the stat-time size and fill that
    // approved snapshot. read() may legally return short, so keep reading.
    // EOF before the snapshot is complete means the file shrank underneath
    // us: in strict mode that is a torn artifact and must not be published;
    // in the default serve mode we stop and return the bounded snapshot we
    // did read (a live-tailing file must never 404).
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await fd.read(buf, offset, stat.size - offset, offset);
      if (bytesRead === 0) {
        if (strictSnapshot) throw new FileLinkDenied('unreadable');
        break;
      }
      offset += bytesRead;
    }
    const finalStat = await fd.stat();
    // A size OR timestamp change between the initial stat and read completion
    // means the file was modified while we read. Size alone misses a same-length
    // in-place overwrite, which can splice bytes from two versions into one
    // buffer; mtime/ctime move on any write, so compare them too. Strict callers
    // (show_file) reject the torn snapshot; serve callers (/view, /download)
    // return the bounded snapshot of exactly the bytes read.
    if (strictSnapshot && (
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs ||
      finalStat.ctimeMs !== stat.ctimeMs
    )) throw new FileLinkDenied('unreadable');
    return { content: buf.subarray(0, offset), realPath };
  } finally {
    await fd?.close().catch(() => {});
  }
}
