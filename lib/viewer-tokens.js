import crypto from 'crypto';

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
export function generateDownloadUrl(baseUrl, filePath, secret = process.env.HMAC_SECRET, expiry = DEFAULT_TOKEN_EXPIRY_SECONDS, workdir = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  const payloadObj = { path: filePath, workdir, dl: true, exp };
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
