import path from 'node:path';

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

  const payload = {
    blob_ref: media.media_id,
    content_type: contentType,
    name: filename,
    filename,
    size,
    ...(caption ? { caption } : {}),
  };
  deps.publish(kind === 'image' ? 'publishImage' : 'publishFile', payload);

  return {
    ok: true,
    media_id: media.media_id,
    kind,
    realPath,
    size: content.length,
    sha256: media.sha256,
  };
}
