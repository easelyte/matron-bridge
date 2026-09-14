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
