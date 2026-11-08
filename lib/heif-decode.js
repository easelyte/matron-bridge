// HEIF/HEIC decoding for buffers sharp cannot read. sharp's prebuilt libvips
// ships libheif with the AV1 codec only (for AVIF), so it has no HEVC
// decoder and rejects every real iPhone HEIC photo or screenshot. This
// decodes those with libheif-js (libheif + libde265 as WebAssembly) in a
// worker thread, returning raw RGBA that sharp can then resize and encode.

import { Worker } from 'node:worker_threads';

// Brands that mean HEVC-coded HEIF (still images and sequences). The
// codec-neutral structural brands 'mif1' and 'msf1' are left out: an AVIF
// carries them too, and sharp decodes AVIF itself.
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);

export const HEIF_DECODE_DEFAULTS = {
  // A 12MP iPhone photo decodes in about a second; leave room for a slow box.
  timeoutMs: 20_000,
  // 64MP covers a 48MP iPhone photo (8064x6048) while keeping the RGBA
  // buffer under about 256MB.
  maxPixels: 64 * 1024 * 1024,
};

// True when the buffer is an ISO-BMFF file whose 'ftyp' box names an HEVC
// HEIF brand as its major or a compatible brand, whatever media type the
// sender declared.
export function isHeif(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  if (buffer.toString('latin1', 4, 8) !== 'ftyp') return false;
  const boxSize = buffer.readUInt32BE(0);
  const end = Math.min(buffer.length, boxSize >= 16 ? boxSize : 16);
  // Major brand at 8, minor version at 12, compatible brands from 16.
  if (HEIF_BRANDS.has(buffer.toString('latin1', 8, 12))) return true;
  for (let off = 16; off + 4 <= end; off += 4) {
    if (HEIF_BRANDS.has(buffer.toString('latin1', off, off + 4))) return true;
  }
  return false;
}

// One HEIC conversion at a time across the whole bridge: each holds up to
// maxPixels of RGBA (about 256MB at the limit) plus a WASM heap, and several
// conversations sending photos at once must not run the box out of memory.
// Callers hold the slot through their JPEG encode too (withHeifSlot).
let heifBusy = false;
const heifWaiting = [];

export async function withHeifSlot(fn) {
  if (heifBusy) await new Promise((resolve) => heifWaiting.push(resolve));
  heifBusy = true;
  try {
    return await fn();
  } finally {
    const next = heifWaiting.shift();
    if (next) next(); else heifBusy = false;
  }
}

// buffer -> { data: Buffer (RGBA), width, height }. Rejects on a parse or
// decode failure, an image over maxPixels, or a decode that runs past
// timeoutMs (the worker is terminated). The timeout starts when the worker
// does, so time spent waiting for a slot does not count.
export function decodeHeif(buffer, overrides = {}) {
  const { timeoutMs, maxPixels } = { ...HEIF_DECODE_DEFAULTS, ...overrides };
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL('./heif-decode-worker.js', import.meta.url), {
      workerData: { buffer, maxPixels },
    });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`HEIC decode timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
    worker.once('message', (msg) => {
      if (msg && msg.ok) {
        const data = Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
        finish(resolve, { data, width: msg.width, height: msg.height });
      } else {
        finish(reject, new Error((msg && msg.error) || 'HEIC decode failed'));
      }
    });
    worker.once('error', (e) => finish(reject, e));
    worker.once('exit', (code) => finish(reject, new Error(`HEIC decoder exited (code ${code})`)));
  });
}
