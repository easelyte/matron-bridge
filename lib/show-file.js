import path from 'node:path';
import { dedupKey } from './media-dedup-ledger.js';

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  // .svg is intentionally absent: image/svg+xml is script-capable when served
  // inline, and the iOS clients decode with UIImage(data:), which cannot render
  // SVG (the operator would get an empty image bubble). An .svg therefore falls
  // through to application/octet-stream and is delivered as a downloadable
  // attachment, which works on every surface.
};

export function parseShowFileUploadTimeoutMs(rawValue, warn = console.warn) {
  if (rawValue === undefined) return 30000;
  const timeoutMs = Number(rawValue);
  if (Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000) {
    return timeoutMs;
  }
  warn(`[show-file] Invalid SHOW_FILE_UPLOAD_TIMEOUT_MS=${JSON.stringify(rawValue)}; defaulting to 30000.`);
  return 30000;
}

export function denialToStatus(reason) {
  if (reason === 'sensitive' || reason === 'outside-scope') return 403;
  if (reason === 'too-large') return 413;
  if (reason === 'not-a-file'
      || reason === 'unreadable'
      || reason === 'symlink'
      || reason === 'relative-path'
      || reason === 'bad-workdir') return 404;
  return 502;
}

export async function shareAgentMedia({
  filePath,
  caption,
  token,
  pinnedRoots,
  maxBytes,
  uploadTimeoutMs,
  deps,
}) {
  // Fail closed if scope was never established. validateAndOpen only enforces
  // containment when the pinned root set is non-empty, so a pinned object with
  // roots: [] (e.g. pinAllowedRootsSync([])) would publish any readable file on
  // the box (subject only to isSensitivePath). shareAgentMedia never passes a
  // workdir fallback, so require an explicit, non-empty pinned root set here
  // rather than assuming createSession always populated it.
  if (!Array.isArray(pinnedRoots?.roots) || pinnedRoots.roots.length === 0) {
    return { denied: 'bad-workdir' };
  }

  let content;
  let realPath;
  try {
    ({ content, realPath } = await deps.validateAndOpen(filePath, {
      allowedRoots: pinnedRoots,
      maxBytes,
      // Publish path: reject a torn/growing file rather than sharing a
      // partial artifact. /view + /download stay on the default snapshot mode.
      strictSnapshot: true,
    }));
  } catch (e) {
    if (e instanceof deps.FileLinkDenied) return { denied: e.reason };
    throw e;
  }

  const mime = MIME_BY_EXTENSION[path.extname(realPath).toLowerCase()]
    || 'application/octet-stream';
  const kind = mime.startsWith('image/') ? 'image' : 'file';
  const filename = path.basename(realPath);
  const media = await deps.uploadMedia({
    bytes: content,
    contentType: mime,
    name: filename,
    timeoutMs: uploadTimeoutMs,
  });
  if (!media) return { denied: 'upload-failed' };

  const contentType = typeof media.content_type === 'string' && media.content_type
    ? media.content_type
    : mime;
  const size = Number.isSafeInteger(media.size) && media.size >= 0
    ? media.size
    : content.length;

  // Idempotency dedup (loop #667). The real duplicate is the LLM agent RE-CALLING
  // show_file after an error — a fresh tool call, so nothing transport-scoped can
  // catch it. Key on the content identity: token (per-session scope) + resolved
  // realPath + the sha256 the journal already computed for the bytes (reused, not
  // recomputed) + caption (so a deliberate re-show with a new caption is NOT
  // suppressed). Within the TTL window a repeat identity SKIPS the re-publish and
  // returns the prior media_id, so the operator sees only the original bubble.
  //
  // Scope note: dedup happens post-upload (that is when the journal-computed
  // sha256 exists), so a duplicate blob is still uploaded to the journal store —
  // but it is orphaned (never published). Suppressing the *visible duplicate* is
  // the #667 harm; eliminating the redundant blob upload would need journal-side
  // sha256 blob-dedup (cross-fork) and is out of scope here.
  //
  // Fail-open throughout: any ledger error must let the publish proceed.
  const sha256 = media.sha256;
  let ledgerKey;
  if (deps.dedupLedger && typeof sha256 === 'string' && sha256) {
    try {
      ledgerKey = dedupKey({ token, realPath, sha256, caption });
      const prior = deps.dedupLedger.get(ledgerKey);
      if (prior && prior.mediaId) {
        return {
          ok: true,
          media_id: prior.mediaId,
          kind: prior.kind || kind,
          realPath,
          size: content.length,
          sha256,
          deduped: true,
        };
      }
    } catch {
      ledgerKey = undefined; // fail-open: don't block publish on a ledger fault
    }
  }

  const payload = {
    blob_ref: media.media_id,
    content_type: contentType,
    name: filename,
    filename,
    size,
    ...(caption ? { caption } : {}),
  };
  deps.publish(kind === 'image' ? 'publishImage' : 'publishFile', payload);

  if (ledgerKey) {
    try {
      deps.dedupLedger.set(ledgerKey, { mediaId: media.media_id, kind });
    } catch {
      // best-effort: recording failure just means the next duplicate re-publishes
    }
  }

  return {
    ok: true,
    media_id: media.media_id,
    kind,
    realPath,
    size: content.length,
    sha256,
    deduped: false,
  };
}
