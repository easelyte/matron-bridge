// Inline-image preparation for prompt injection: decide whether a client-sent
// image can go into the claude API call as-is, needs a downscaled JPEG copy,
// or must be left on disk for the Read tool. The full-resolution original is
// ALWAYS saved to the session workdir by buildSavedMediaBlocks regardless of
// what happens here — this module only governs the base64 block attached to
// the prompt, never the bytes on disk or in the journal blob store.
//
// Why: the API hard-rejects images over ~5MB or 8000px, so a phone photo
// injected verbatim fails the whole turn; and anything over 1568px on the
// long edge is downscaled server-side anyway, so shipping more than that
// only buys upload latency. Downscaling here (and re-encoding byte-heavy or
// API-unsupported formats to JPEG) makes injection robust while the on-disk
// original keeps full detail one Read away.

import sharp from 'sharp';

// The only media types the API accepts in an image block. Anything else that
// sharp can decode gets transcoded to JPEG; anything it can't is skipped.
const API_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// The API rejects images over 8000px on a side outright.
const API_MAX_LONG_EDGE = 8000;

export const INLINE_IMAGE_DEFAULTS = {
  // Anthropic's documented optimal long edge — larger is downscaled
  // server-side, so resizing past this loses nothing.
  maxLongEdge: 1568,
  // Re-encode even a small-dimension image over this size (a dense PNG can be
  // multi-MB at modest pixels). Well under the API's 5MB cap: base64 inflates
  // by 4/3, and a 1568px JPEG lands around 150–500KB anyway.
  reencodeBytes: 1.5 * 1024 * 1024,
  jpegQuality: 80,
  // Pathological case: if the first pass is somehow still over this, retry
  // once, smaller and rougher, then accept whatever that produces (a
  // retryLongEdge JPEG cannot approach the API cap).
  retryBytes: 2 * 1024 * 1024,
  retryLongEdge: 1024,
  retryQuality: 55,
  // Safety margin under the API's 5MB per-image limit, used for buffers we
  // cannot decode and therefore cannot shrink.
  hardMaxBytes: 4.5 * 1024 * 1024,
};

// (buffer, mime) -> one of:
//   { action: 'passthrough' }                                  inline the original
//   { action: 'replace', buffer, mediaType, width, height }    inline this JPEG instead
//   { action: 'skip', reason }                                 no inline block; disk copy only
// Never throws: an undecodable or unprocessable image degrades to passthrough
// (when the original is safe to send) or skip (when it isn't).
export async function prepareInlineImage(buffer, mime, overrides = {}) {
  const opts = { ...INLINE_IMAGE_DEFAULTS, ...overrides };
  if (typeof mime !== 'string' || !mime.startsWith('image/')) return { action: 'passthrough' };

  // Passthrough/skip for a buffer we can't produce a downscaled copy of —
  // unparseable header, or a decode/encode failure AFTER metadata succeeded
  // (data corrupt past the header, or an input over sharp's
  // decompression-bomb pixel guard). The original is only safe to inline when
  // the API accepts its declared type, it's under the hard byte cap, and —
  // when the header told us dimensions — under the API's pixel limit too.
  // (HEIC lands here — prebuilt libvips has no HEIC decoder — which is
  // strictly better than today's behavior of sending image/heic and failing
  // the whole turn.)
  const inlineOriginalFallback = (knownLongEdge = 0) => {
    if (!API_IMAGE_TYPES.has(mime)) {
      return { action: 'skip', reason: `${mime} is not supported for inline attachment and could not be converted` };
    }
    if (buffer.length > opts.hardMaxBytes) {
      return { action: 'skip', reason: 'too large to attach inline and could not be downscaled' };
    }
    if (knownLongEdge > API_MAX_LONG_EDGE) {
      return { action: 'skip', reason: `too large to attach inline (${knownLongEdge}px exceeds the ${API_MAX_LONG_EDGE}px limit) and could not be downscaled` };
    }
    return { action: 'passthrough' };
  };

  let meta;
  try {
    // limitInputPixels:false — metadata() is a header-only parse, so lifting
    // the pixel guard here is safe and means dimensions are known even for
    // gigantic declarations; the guard stays ON for the real decode in
    // encode(), whose failure the fallback then judges with these dimensions.
    meta = await sharp(buffer, { limitInputPixels: false }).metadata();
  } catch {
    return inlineOriginalFallback();
  }

  // Long edge is rotation-invariant, so EXIF orientation (which swaps
  // width/height at render time) can't change this decision.
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  const needsWork = longEdge > opts.maxLongEdge
    || buffer.length > opts.reencodeBytes
    || !API_IMAGE_TYPES.has(mime);
  if (!needsWork) return { action: 'passthrough' };

  // Animated GIF/WebP under the API's hard limits passes through untouched:
  // re-encoding would keep only the first frame, and the API downscales
  // oversized-but-legal pixels itself.
  const animated = (meta.pages || 1) > 1;
  if (animated && API_IMAGE_TYPES.has(mime)
    && buffer.length <= opts.hardMaxBytes && longEdge <= API_MAX_LONG_EDGE) {
    return { action: 'passthrough' };
  }

  // .rotate() applies EXIF orientation (and strips the tag) BEFORE resize, so
  // the fit box matches what the user actually sees; flatten fills alpha with
  // white since JPEG has no transparency.
  const encode = (edge, quality) => sharp(buffer)
    .rotate()
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  try {
    let { data, info } = await encode(opts.maxLongEdge, opts.jpegQuality);
    if (data.length > opts.retryBytes) {
      ({ data, info } = await encode(opts.retryLongEdge, opts.retryQuality));
    }
    return { action: 'replace', buffer: data, mediaType: 'image/jpeg', width: info.width, height: info.height };
  } catch {
    // Decodable metadata but a failed encode (corrupt image data past the
    // header, over the pixel guard, exotic subformat): same safety rule as
    // undecodable input, judged with the dimensions we DO know.
    return inlineOriginalFallback(longEdge);
  }
}

// Push the inline image block(s) a saved image contributes to the prompt,
// according to a prepareInlineImage decision. `buffer`/`mime` are the
// full-resolution original (used on passthrough); `savePath` is where that
// original lives on disk, so the replace/skip hints can point claude's Read
// tool at it.
export function appendInlineImageBlocks(blocks, { buffer, mime, inline, savePath }) {
  const decision = inline || { action: 'passthrough' };
  if (decision.action === 'replace') {
    blocks.push({
      type: 'text',
      text: `(attached copy downscaled to ${decision.width}x${decision.height}; full-resolution original saved to ${savePath} — Read it if you need full detail)`,
    });
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: decision.mediaType, data: decision.buffer.toString('base64') },
    });
    return;
  }
  if (decision.action === 'skip') {
    blocks.push({
      type: 'text',
      text: `(image not attached inline: ${decision.reason}; saved to ${savePath} — use the Read tool to view it)`,
    });
    return;
  }
  blocks.push({
    type: 'image',
    source: { type: 'base64', media_type: mime, data: buffer.toString('base64') },
  });
}
