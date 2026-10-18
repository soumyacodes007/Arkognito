// Reads an Aadhaar secure QR from pixels. A test card's QR is dense (version 27, 125×125 modules), so a
// screenshot or a phone photo often has under 2 pixels per module: ZXing (WebAssembly) reads those,
// jsQR only from about 2 px/module up. ZXing first, jsQR as a fallback.
import jsQR from 'jsqr';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

// Served by this app, not fetched from a CDN.
prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } });

const MAX_SIDE = 2400; // big phone photos are scaled down first; decoding stays fast

/** Pixels of an image file, scaled so the long side is at most MAX_SIDE. */
export function imageDataFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => reject(new Error('That file is not a picture.'));
    img.src = URL.createObjectURL(file);
  });
}

/** The QR's text, or null. `quick` skips the slower passes (for live camera frames). */
export async function decodeQr(imageData, { quick = false } = {}) {
  try {
    const [hit] = await readBarcodes(imageData, { formats: ['QRCode'], tryHarder: !quick, tryInvert: !quick, maxNumberOfSymbols: 1 });
    if (hit?.text) return hit.text;
  } catch {
    /* fall through to jsQR */
  }
  return jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: quick ? 'dontInvert' : 'attemptBoth' })?.data ?? null;
}
