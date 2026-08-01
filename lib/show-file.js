import path from 'node:path';

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
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

export async function shareAgentMedia({
  filePath,
  caption,
  pinnedRoots,
  maxBytes,
  uploadTimeoutMs,
  deps,
}) {
  let content;
  let realPath;
  try {
    ({ content, realPath } = await deps.validateAndOpen(filePath, {
      allowedRoots: pinnedRoots,
      maxBytes,
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

  const payload = {
    blob_ref: media.media_id,
    content_type: media.content_type,
    name: filename,
    filename,
    size: media.size,
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
