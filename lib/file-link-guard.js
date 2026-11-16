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
// /page renders one self-contained HTML file (pictures and clips inlined as
// data: URLs, so a few MB is normal) as a web page.
export const MAX_PAGE_BYTES = 25 * 1024 * 1024;

// Only HTML files are rendered by /page. Anything else has a better route
// (/view for source, /download for bytes), and refusing it keeps a page link
// from turning, say, an SVG or a text file into a document the browser runs.
export function isPageFile(filePath) {
  return /\.html?$/i.test(String(filePath));
}

// Headers for an agent-written page served by the viewer. The viewer origin
// also serves the secret-request form and the sensitive-data pages, so the
// page must not run with that origin's powers. `sandbox` without
// allow-same-origin gives the document a unique opaque origin even when it is
// the top-level page: its scripts cannot read or post as the viewer (a
// same-origin fetch becomes a cross-origin one with no CORS grant), and it
// gets no cookies or storage. The rest of the policy lets a self-contained
// page work (its own inline script and style, data:/blob: media, https
// images and fonts, links that open in a new, unsandboxed tab) while
// refusing what such a page has no need for: script from anywhere else
// (third-party code could read the signed link from location), network
// reads, form posts, a <base> override, and being framed by another site. no-referrer keeps the
// link's token out of the Referer of anything the page links to.
export const PAGE_SANDBOX = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
export const PAGE_CSP = [
  PAGE_SANDBOX,
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline' data: https:",
  'img-src data: blob: https:',
  'media-src data: blob: https:',
  'font-src data: https:',
  'connect-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
export const PAGE_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': PAGE_CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  // no-transform: a CDN in front of the viewer must serve the page as
  // written. Cloudflare's email obfuscation, for one, rewrites addresses and
  // injects a decoder script, which the CSP then blocks, so the address
  // would show as a placeholder.
  'Cache-Control': 'private, no-store, no-transform',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), payment=(), clipboard-read=()',
});

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
  // Credential files whose names the patterns above miss.
  /^auth\.json$/i,
  /^\.git-credentials$/i,
  /^\.pgpass$/i,
  /^\.claude\.json$/i,
  /^\.secrets?$/i,
  /[-_.]secrets?$/i,
  // Bearer material with no .json/.txt extension (agent-token, access-token, creds).
  /(^|[-_.])(agent|access|refresh|api|auth|bearer)[-_]?tokens?(\.(txt|json))?$/i,
  /(^|[-_.])creds?(\.(txt|json|ya?ml|toml))?$/i,
  // The bridge's own state files.
  /^\.claude-matrix-/i,
  /^\.matron-bridge-/i,
  /^\.claude-queued-release-outbox\.json$/i,
  /^\.claude-subagent-running\.json$/i,
  /^journal-cursor\.json$/i,
  // Shell / REPL history routinely holds pasted tokens.
  /^\.[a-z0-9]*_?history$/i,
];

const SENSITIVE_PATH_PATTERNS = [
  // Credential/config directories: a session whose workdir is $HOME must not
  // be able to share ~/.codex/auth.json or ~/.config/gh/hosts.yml.
  /\/\.codex(\/|$)/i,
  /\/\.config(\/|$)/i,
  /\/\.gcloud(\/|$)/i,
  /\/\.azure(\/|$)/i,
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

// Rebuild a pinned-root capability from root identities captured earlier, at a
// trusted moment, and carried across a boundary (a signed viewer token). A bare
// pathname is not an authorization boundary: a workdir renamed away and replaced
// by a symlink after a link is minted would be re-resolved to the attacker's
// target. validateAndOpen re-stats each pinned root and rejects a dev/ino change.
// Fails closed: an empty or malformed list throws rather than degrading to an
// unchecked read.
export function pinAllowedRootIdentities(identities) {
  if (!Array.isArray(identities) || identities.length === 0) {
    throw new FileLinkDenied('bad-workdir');
  }
  const roots = [];
  for (const entry of identities) {
    if (!entry
        || typeof entry.realPath !== 'string'
        || !path.isAbsolute(entry.realPath)
        || !Number.isFinite(entry.dev)
        || !Number.isFinite(entry.ino)) {
      throw new FileLinkDenied('bad-workdir');
    }
    roots.push(Object.freeze({ realPath: entry.realPath, dev: entry.dev, ino: entry.ino }));
  }
  return Object.freeze({ [PINNED_ROOTS]: true, roots: Object.freeze(roots) });
}

// Real path of the file an open descriptor holds. Linux asks procfs, which
// answers from the descriptor itself. Elsewhere the pathname must be re-resolved,
// which is racy (O_NOFOLLOW only covers the final component), so the resolved
// name is accepted only if its dev/ino still matches the descriptor; otherwise
// 'path-race'. A hardlink planted in scope can still satisfy that check; closing
// it needs openat()/O_PATH, which Node does not expose.
export async function fdRealPath(fd, resolvedPath, fdStat, platform = process.platform) {
  if (platform === 'linux') return fsp.readlink(`/proc/self/fd/${fd.fd}`);
  let realPath;
  let nameStat;
  try {
    realPath = await fsp.realpath(resolvedPath);
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
// fails with ELOOP), resolves the fd's REAL path via /proc/self/fd (immune
// to path swaps after open — symlinked parent dirs land on their target
// here), then re-checks sensitivity, containment, type, and size before
// reading THROUGH THE FD. Throws FileLinkDenied for every rejection it
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
    // On Windows Node ignores O_NOFOLLOW, so a symlink final component would
    // be followed. Refuse it up front there; elsewhere O_NOFOLLOW below is the
    // race-free guard and this lstat only answers early.
    try {
      if ((await fsp.lstat(path.resolve(filePath))).isSymbolicLink()) throw new FileLinkDenied('symlink');
    } catch (err) {
      if (err instanceof FileLinkDenied) throw err;
      throw new FileLinkDenied('unreadable');
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
