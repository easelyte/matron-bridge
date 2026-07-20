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

// Serve-time boundary. Opens with O_NOFOLLOW (a symlink final component
// fails with ELOOP), resolves the fd's REAL path via /proc/self/fd (immune
// to path swaps after open — symlinked parent dirs land on their target
// here), then re-checks sensitivity, containment, type, and size before
// reading THROUGH THE FD. Throws FileLinkDenied for every rejection it
// detects; an unexpected system error (procfs missing, EIO) propagates raw —
// callers must 404 on ANY throw, not just FileLinkDenied.
export async function validateAndOpen(filePath, { workdir, maxBytes = MAX_VIEW_BYTES } = {}) {
  let fd;
  try {
    if (!path.isAbsolute(String(filePath))) throw new FileLinkDenied('relative-path');
    try {
      fd = await fsp.open(path.resolve(filePath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      throw new FileLinkDenied(err.code === 'ELOOP' ? 'symlink' : 'unreadable');
    }
    // Linux: resolve the fd's REAL path via procfs — immune to path swaps
    // after open. macOS has no /proc, so fall back to realpath() of the
    // opened path: the final component is already symlink-proof (O_NOFOLLOW)
    // but a parent-dir swap between open and realpath is not detected.
    // Acceptable on the single-user Mac deployment; the Linux boxes keep
    // the fd-pinned form.
    const realPath = process.platform === 'linux'
      ? await fsp.readlink(`/proc/self/fd/${fd.fd}`)
      : await fsp.realpath(path.resolve(filePath));
    if (isSensitivePath(realPath)) throw new FileLinkDenied('sensitive');
    if (workdir) {
      let realWorkdir;
      try {
        realWorkdir = await fsp.realpath(workdir);
      } catch {
        throw new FileLinkDenied('bad-workdir');
      }
      if (!contains(realWorkdir, realPath)) throw new FileLinkDenied('outside-workdir');
    }
    const stat = await fd.stat();
    if (!stat.isFile()) throw new FileLinkDenied('not-a-file');
    if (stat.size > maxBytes) throw new FileLinkDenied('too-large');
    // Bounded read: allocate exactly the stat-time size and read at most
    // that many bytes from offset 0 — a file that grows between stat and
    // read cannot inflate the response past the size we approved.
    const buf = Buffer.alloc(stat.size);
    const { bytesRead } = await fd.read(buf, 0, stat.size, 0);
    const content = buf.subarray(0, bytesRead);
    return { content, realPath };
  } finally {
    await fd?.close().catch(() => {});
  }
}
