// Decodes any image format the browser supports (JPEG, PNG, WebP, AVIF, HEIC on Safari)
// into RGBA pixels. Works inside a Web Worker via OffscreenCanvas.

import type { Raster } from '../analyzers/image-math.js';

export async function decodeWithBrowser(bytes: Uint8Array, type: string, maxSide = 4096): Promise<Raster> {
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas not available');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}
