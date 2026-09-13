import crypto from 'crypto';
import { pinAllowedRootIdentities } from './file-link-guard.js';

const DEFAULT_TOKEN_EXPIRY_SECONDS = parseInt(process.env.TOKEN_EXPIRY || '3600', 10);

// Generate a signed token for a file path or arbitrary payload.
// Token format: base64url(json({path, exp})) + '.' + hmac
export function generateSignedUrl(baseUrl, filePath, secret = process.env.HMAC_SECRET, expiry = DEFAULT_TOKEN_EXPIRY_SECONDS, extra = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  const payloadObj = extra ? { ...extra, exp } : { path: filePath, exp };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${baseUrl}/view?token=${payload}.${sig}`;
}

// Signed /download link: same token scheme as /view, distinguished by the
// dl flag so a leaked /view token can't be replayed as a raw download (and
// vice versa — /view ignores dl tokens' looser size budget).
export function generateDownloadUrl(baseUrl, filePath, secret = process.env.HMAC_SECRET, expiry = DEFAULT_TOKEN_EXPIRY_SECONDS, workdir = null, roots = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  const payloadObj = { path: filePath, workdir, roots, dl: true, exp };
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
  if (Array.isArray(data?.roots) && data.roots.length > 0) {
    return { allowedRoots: pinAllowedRootIdentities(data.roots) };
  }
  return { workdir: data?.workdir };
}
