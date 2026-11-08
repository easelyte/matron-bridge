// Worker half of lib/heif-decode.js: decodes one HEIF/HEIC buffer to 8-bit
// RGBA with libheif compiled to WebAssembly (it bundles libde265, the HEVC
// decoder sharp's prebuilt libvips lacks). Runs off the main thread because
// the WASM decode is synchronous and a 12MP photo takes about a second —
// the bridge's event loop must not stall for it — and so the parent can
// terminate a decode that hangs.

import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// libheif-js reports parse and decode failures with console.log and an
// empty result. Keep the last line as the error message instead of letting
// it reach the bridge's log unlabelled.
let lastLibheifMessage = '';
console.log = (...args) => {
  lastLibheifMessage = args.map((a) => (typeof a === 'string' ? a : (a && a.message) || String(a))).join(' ');
};

async function decode({ buffer, maxPixels }) {
  const libheif = require('libheif-js/wasm-bundle');
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  if (!images.length) throw new Error(lastLibheifMessage || 'no image found in the HEIF container');
  try {
    // The primary image is what the Photos app shows; thumbnails, depth maps
    // and gain maps are auxiliary and never top-level, but a file can carry
    // several top-level images, so pick the primary one explicitly.
    const image = images.find((img) => img.is_primary()) || images[0];
    // Dimensions come from the container (after libheif's rotation and
    // mirroring transforms, and for a grid image the whole grid), so the
    // pixel guard runs before any RGBA buffer is allocated.
    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height) throw new Error('HEIF image has no dimensions');
    if (width * height > maxPixels) {
      throw new Error(`HEIF image is ${width}x${height}, over the ${maxPixels}-pixel decode limit`);
    }
    const out = { data: new Uint8ClampedArray(width * height * 4), width, height };
    // display() converts to interleaved 8-bit RGBA (reducing 10-bit or HDR
    // content to 8 bits) and calls back with null on a decode failure.
    const result = await new Promise((resolve) => image.display(out, resolve));
    if (!result) throw new Error(lastLibheifMessage || 'libheif could not decode the image');
    return { width, height, data: result.data };
  } finally {
    for (const img of images) img.free();
    if (decoder.decoder && typeof decoder.decoder.delete === 'function') decoder.decoder.delete();
  }
}

try {
  const { width, height, data } = await decode(workerData);
  parentPort.postMessage({ ok: true, width, height, data }, [data.buffer]);
} catch (e) {
  parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
}
