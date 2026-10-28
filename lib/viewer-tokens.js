import crypto from 'crypto';
import { pinAllowedRootIdentities, pinAllowedRootsSync, FileLinkDenied } from './file-link-guard.js';

const DEFAULT_TOKEN_EXPIRY_SECONDS = parseInt(process.env.TOKEN_EXPIRY || '3600', 10);

// Generate a signed token for a file path or arbitrary payload.
// Token format: base64url(json({path, exp})) + '.' + hmac
export function generateSignedUrl(baseUrl, filePath, secret = process.env.HMAC_SECRET, expiry = DEFAULT_TOKEN_EXPIRY_SECONDS, extra = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  // A payload that claims a workdir scope gets that scope PINNED, always. The
  // minter cannot emit a pathname-only scope by omission, which is what makes
  // the verifier's "workdir implies roots" rule safe to enforce. Callers on a
  // hot path pass `roots` themselves — the pin here is synchronous filesystem
  // work. Throws FileLinkDenied if the workdir does not resolve.
  const payloadObj = extra ? { ...extra, exp } : { path: filePath, exp };
  if (payloadObj.workdir && !payloadObj.roots) {
    payloadObj.roots = pinAllowedRootsSync([payloadObj.workdir]).roots
      .map(({ realPath, dev, ino }) => ({ realPath, dev, ino }));
  }
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${baseUrl}/view?token=${payload}.${sig}`;
}

// Signed /download link: same token scheme as /view, distinguished by the
// dl flag so a leaked /view token can't be replayed as a raw download (and
// vice versa — /view ignores dl tokens' looser size budget).
export function generateDownloadUrl(baseUrl, filePath, secret = process.env.HMAC_SECRET, expiry = DEFAULT_TOKEN_EXPIRY_SECONDS, workdir = null, roots = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  // A workdir is a scope only if its IDENTITY is pinned, so this generator
  // cannot mint a pathname-only scoped token: supply pre-pinned identities, or
  // it pins the workdir itself. Callers on a hot path must pass `roots` — the
  // internal pin does synchronous filesystem work. Throws FileLinkDenied if
  // the workdir does not resolve; a scope we cannot pin mints no token.
  const pinnedRoots = workdir
    ? (roots || pinAllowedRootsSync([workdir]).roots.map(({ realPath, dev, ino }) => ({ realPath, dev, ino })))
    : null;
  // `roots` is OMITTED, not null, for an unscoped token: an explicitly present
  // roots field is an assertion of scope, and scopeFromToken fails closed on
  // one it cannot honour.
  const payloadObj = workdir
    ? { path: filePath, workdir, roots: pinnedRoots, dl: true, exp }
    : { path: filePath, workdir: null, dl: true, exp };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${baseUrl}/download?token=${payload}.${sig}`;
}

// A /page link is made to be passed on (a report, a demo pack), and a
// signed payload is only encoded, not hidden: anyone holding the link could
// read the box's home directory, user name and repository path out of it.
// So the path and workdir ride sealed (AES-256-GCM under a key derived from
// the HMAC secret, which the bridge and the viewer share); the signature
// still covers the sealed blob, the flag and the expiry.
function pageKey(secret) {
  return crypto.createHash('sha256').update(`matron-page:${secret}`).digest();
}

export function sealPagePayload({ path: filePath, workdir, roots }, secret = process.env.HMAC_SECRET) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', pageKey(secret), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(roots ? { path: filePath, workdir, roots } : { path: filePath, workdir }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

export function openPagePayload(sealed, secret = process.env.HMAC_SECRET) {
  if (typeof sealed !== 'string') return null;
  try {
    const buf = Buffer.from(sealed, 'base64url');
    if (buf.length < 12 + 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', pageKey(secret), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    const inner = JSON.parse(plain);
    if (!inner || typeof inner.path !== 'string') return null;
    return {
      path: inner.path,
      workdir: typeof inner.workdir === 'string' ? inner.workdir : null,
      ...(Array.isArray(inner.roots) ? { roots: inner.roots } : {}),
    };
  } catch {
    return null;
  }
}

// Signed /page link: renders one HTML file from the workdir as a sandboxed
// web page. The page flag ties the token to that route, as dl does for
// /download, so a short-lived /view token cannot be replayed onto /page and
// a page token cannot become a raw download. The path, workdir and pinned
// root identities are sealed (above), never in the clear.
export function generatePageUrl(baseUrl, filePath, secret = process.env.HMAC_SECRET, expiry = DEFAULT_TOKEN_EXPIRY_SECONDS, workdir = null, roots = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  // Same scope rule as generateDownloadUrl: a workdir is a scope only with its
  // identity pinned. The pinned roots ride inside the sealed blob; `roots` is
  // omitted (not null) for an unscoped token.
  const pinnedRoots = workdir
    ? (roots || pinAllowedRootsSync([workdir]).roots.map(({ realPath, dev, ino }) => ({ realPath, dev, ino })))
    : null;
  const payloadObj = { p: sealPagePayload({ path: filePath, workdir, ...(pinnedRoots ? { roots: pinnedRoots } : {}) }, secret), page: true, exp };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${baseUrl}/page?token=${payload}.${sig}`;
}

// A /page token's contents: the signed outer data with the sealed path and
// workdir opened, or null for anything that is not a valid, unexpired page
// token. A token minted before paths were sealed (path in the clear) still
// opens, so links handed out earlier keep working until they expire.
export function readPageToken(token, secret = process.env.HMAC_SECRET) {
  const data = verifyToken(token, secret);
  if (!data || data.page !== true) return null;
  if (typeof data.p === 'string') {
    const inner = openPagePayload(data.p, secret);
    if (!inner) return null;
    const { p: _sealed, ...rest } = data;
    return { ...rest, ...inner };
  }
  return typeof data.path === 'string' ? data : null;
}

export function verifyToken(token, secret = process.env.HMAC_SECRET) {
  // Express query/body params can arrive as arrays or objects
  // (?token=a&token=b). Only a plain string can be a valid token; reject
  // anything else before doing string/Buffer work on it.
  if (typeof token !== 'string') return null;
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBytes = Buffer.from(sig);
  const expectedBytes = Buffer.from(expectedSig);
  if (sigBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(sigBytes, expectedBytes)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

// Translate a VERIFIED token's scope fields into validateAndOpen options.
//
// `roots` carries the workdir's filesystem identity (realPath + dev/ino) as it
// was when the link was MINTED, so the guard can reject a workdir that has
// since been renamed and replaced by a symlink to somewhere else. The bare
// `workdir` pathname cannot express that: the serve-time re-resolve follows
// the attacker's replacement and containment passes against the wrong
// directory. Prefer the pinned form whenever the token carries it.
//
// Tokens minted before `roots` existed carry only the pathname and keep the
// old identity-free containment. They are short-lived (TOKEN_EXPIRY, 1h by
// default), so this is a drain, not a permanent second path — but it IS the
// weaker path, which is why new tokens always carry roots.
export function scopeFromToken(data) {
  // Present-but-unusable fails CLOSED. A token that carries a roots field is
  // asserting a pinned scope; if that assertion is null, empty, or malformed,
  // honouring the mutable `workdir` instead would silently downgrade the
  // stronger boundary to the weaker one — exactly the move an attacker wants.
  if (data?.workdir) {
    if (!Array.isArray(data.roots) || data.roots.length === 0) {
      // A workdir WITHOUT pinned roots is the mutable-pathname scope this
      // change exists to remove, so it is refused outright rather than served
      // under the weaker boundary. Both minters above pin unconditionally, so
      // the only tokens this rejects are ones minted by a previous process;
      // they stop working for at most one token lifetime after a restart,
      // which is a broken link, not a leak. Accepting them "for compatibility"
      // would keep the exploitable path alive indefinitely, and anything that
      // can rename a workdir can also wait out a drain window.
      throw new FileLinkDenied('bad-workdir');
    }
    return { allowedRoots: pinAllowedRootIdentities(data.roots) };
  }
  // No workdir at all: an unscoped token, containment-free by construction
  // (pre-existing behaviour — the denylist and size caps still apply).
  return { workdir: undefined };
}
