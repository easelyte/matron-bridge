import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  prepareInlineImage,
  appendInlineImageBlocks,
  INLINE_IMAGE_DEFAULTS,
} from '../lib/inline-image.js';

// Real image fixtures generated with sharp — no binary files in the repo, and
// the assertions decode the output with sharp again so they exercise actual
// image behavior (dimensions, format, alpha), not mock plumbing.

function flatJpeg(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 130, b: 140 } } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

// Gaussian noise is incompressible, so this makes byte-heavy files at small
// dimensions (a flat-color image of any size compresses to almost nothing).
function noisePng(width, height, channels = 3) {
  return sharp({
    create: {
      width, height, channels,
      background: { r: 128, g: 128, b: 128, alpha: 0.5 },
      noise: { type: 'gaussian', mean: 128, sigma: 30 },
    },
  }).png().toBuffer();
}

describe('prepareInlineImage — passthrough cases', () => {
  it('passes a small, API-supported image through untouched', async () => {
    const buf = await flatJpeg(400, 300);
    const res = await prepareInlineImage(buf, 'image/jpeg');
    expect(res).toEqual({ action: 'passthrough' });
  });

  it('passes non-image mimes through (caller inlines the original)', async () => {
    const res = await prepareInlineImage(Buffer.from('%PDF-1.4 ...'), 'application/pdf');
    expect(res).toEqual({ action: 'passthrough' });
  });

  it('passes an undecodable buffer through when its declared type is API-supported and small', async () => {
    const res = await prepareInlineImage(Buffer.from('not really an image'), 'image/png');
    expect(res).toEqual({ action: 'passthrough' });
  });
});

describe('prepareInlineImage — downscale / re-encode', () => {
  it('downscales an image over the long-edge cap and re-encodes to JPEG', async () => {
    const buf = await flatJpeg(3200, 2400);
    const res = await prepareInlineImage(buf, 'image/jpeg');
    expect(res.action).toBe('replace');
    expect(res.mediaType).toBe('image/jpeg');
    expect(res.width).toBe(INLINE_IMAGE_DEFAULTS.maxLongEdge);
    expect(res.height).toBe(Math.round((2400 / 3200) * INLINE_IMAGE_DEFAULTS.maxLongEdge));
    const meta = await sharp(res.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width, meta.height)).toBe(INLINE_IMAGE_DEFAULTS.maxLongEdge);
  });

  it('re-encodes a byte-heavy image even when its dimensions are under the cap', async () => {
    const buf = await noisePng(1400, 1200);
    expect(buf.length).toBeGreaterThan(INLINE_IMAGE_DEFAULTS.reencodeBytes); // fixture sanity
    const res = await prepareInlineImage(buf, 'image/png');
    expect(res.action).toBe('replace');
    expect(res.mediaType).toBe('image/jpeg');
    expect(res.width).toBe(1400);
    expect(res.height).toBe(1200);
    expect(res.buffer.length).toBeLessThan(buf.length);
  });

  it('flattens alpha when converting to JPEG', async () => {
    const buf = await noisePng(2000, 2000, 4);
    const res = await prepareInlineImage(buf, 'image/png');
    expect(res.action).toBe('replace');
    const meta = await sharp(res.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.hasAlpha).toBe(false);
  });

  it('applies EXIF orientation before resizing (long edge follows the rotated image)', async () => {
    const rotated = await sharp(await flatJpeg(4000, 2000))
      .withMetadata({ orientation: 6 }) // 90° CW: renders as 2000x4000
      .toBuffer();
    const res = await prepareInlineImage(rotated, 'image/jpeg');
    expect(res.action).toBe('replace');
    expect(res.height).toBe(INLINE_IMAGE_DEFAULTS.maxLongEdge);
    expect(res.width).toBe(Math.round((2000 / 4000) * INLINE_IMAGE_DEFAULTS.maxLongEdge));
    const meta = await sharp(res.buffer).metadata();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it('transcodes a decodable but API-unsupported format regardless of size', async () => {
    const buf = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .tiff().toBuffer();
    const res = await prepareInlineImage(buf, 'image/tiff');
    expect(res.action).toBe('replace');
    expect(res.mediaType).toBe('image/jpeg');
    expect(res.width).toBe(200);
    expect(res.height).toBe(100);
  });

  it('retries at reduced quality/dimensions when the first pass is still over the retry cap', async () => {
    const buf = await noisePng(900, 600);
    const res = await prepareInlineImage(buf, 'image/png', {
      reencodeBytes: 1000, // force the re-encode path
      retryBytes: 1000, // first JPEG pass of noise cannot get under 1KB
      retryLongEdge: 64,
    });
    expect(res.action).toBe('replace');
    expect(Math.max(res.width, res.height)).toBe(64);
  });
});

describe('prepareInlineImage — skip cases', () => {
  it('skips when encode fails on an image whose known dimensions exceed the API pixel limit', async () => {
    // A real JPEG whose SOF0 header is patched to declare 30000x30000:
    // metadata() (header-only parse) reports the huge dimensions, but the full
    // decode trips sharp's input pixel guard, so encode fails AFTER the
    // dimensions are known — the fallback must not inline an image the API
    // would reject on pixels alone.
    const buf = await flatJpeg(100, 80);
    const sof = buf.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(-1);
    buf.writeUInt16BE(30000, sof + 5); // SOF0 height
    buf.writeUInt16BE(30000, sof + 7); // SOF0 width
    const meta = await sharp(buf, { limitInputPixels: false }).metadata();
    expect(meta.width).toBe(30000); // fixture sanity: header now declares huge dims
    const res = await prepareInlineImage(buf, 'image/jpeg');
    expect(res.action).toBe('skip');
    expect(res.reason).toMatch(/8000/);
  });

  it('skips an undecodable buffer over the API byte cap', async () => {
    const buf = Buffer.alloc(INLINE_IMAGE_DEFAULTS.hardMaxBytes + 1, 7);
    const res = await prepareInlineImage(buf, 'image/png');
    expect(res.action).toBe('skip');
    expect(res.reason).toMatch(/large/i);
  });

  it('skips an undecodable buffer whose declared type the API does not accept', async () => {
    const res = await prepareInlineImage(Buffer.from('ftypheic-ish garbage'), 'image/heic');
    expect(res.action).toBe('skip');
    expect(res.reason).toMatch(/image\/heic/);
  });
});

describe('appendInlineImageBlocks', () => {
  const savePath = '/w/photo.jpg';
  const original = Buffer.from('original-bytes');

  it('pushes the original base64 block on passthrough (and when no decision is given)', () => {
    for (const inline of [{ action: 'passthrough' }, null, undefined]) {
      const blocks = [];
      appendInlineImageBlocks(blocks, { buffer: original, mime: 'image/png', inline, savePath });
      expect(blocks).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: original.toString('base64') } },
      ]);
    }
  });

  it('pushes the downscaled copy plus a full-resolution hint on replace', () => {
    const small = Buffer.from('downscaled-bytes');
    const blocks = [];
    appendInlineImageBlocks(blocks, {
      buffer: original, mime: 'image/png',
      inline: { action: 'replace', buffer: small, mediaType: 'image/jpeg', width: 1568, height: 1176 },
      savePath,
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('1568x1176');
    expect(blocks[0].text).toContain(savePath);
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: small.toString('base64') },
    });
  });

  it('pushes only a Read-the-file hint on skip', () => {
    const blocks = [];
    appendInlineImageBlocks(blocks, {
      buffer: original, mime: 'image/heic',
      inline: { action: 'skip', reason: 'image/heic is not supported' },
      savePath,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain(savePath);
    expect(blocks[0].text).toContain('image/heic is not supported');
    expect(blocks[0].text).toMatch(/Read/);
  });
});
