// Small image utilities on raw RGBA buffers. Pure TypeScript so they run in a Web Worker,
// in Node tests and on any platform without native dependencies.

import jpeg from 'jpeg-js';

// jpeg-js returns Node Buffers when bundled as CommonJS. Browsers and workers have no Buffer,
// so provide the two methods it uses, backed by Uint8Array.
const g = globalThis as { Buffer?: unknown };
g.Buffer ??= { from: (a: ArrayLike<number>) => Uint8Array.from(a), alloc: (n: number) => new Uint8Array(n) };

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel */
  readonly data: Uint8Array | Uint8ClampedArray;
}

export const MAX_MEGAPIXELS = 40;

export function decodeJpeg(bytes: Uint8Array): Raster {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_MEGAPIXELS, maxMemoryUsageInMB: 1024 });
  return { width: img.width, height: img.height, data: img.data };
}

export function encodeJpeg(r: Raster, quality: number): Uint8Array {
  const out = jpeg.encode({ width: r.width, height: r.height, data: r.data as Uint8Array }, quality);
  return new Uint8Array(out.data);
}

/** Box-filter resize to a small grayscale grid (used for perceptual hashes). */
export function grayGrid(r: Raster, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  const cnt = new Float64Array(w * h);
  for (let y = 0; y < r.height; y++) {
    const gy = Math.min(h - 1, Math.floor((y * h) / r.height));
    for (let x = 0; x < r.width; x++) {
      const gx = Math.min(w - 1, Math.floor((x * w) / r.width));
      const i = (y * r.width + x) * 4;
      out[gy * w + gx]! += 0.299 * r.data[i]! + 0.587 * r.data[i + 1]! + 0.114 * r.data[i + 2]!;
      cnt[gy * w + gx]! += 1;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / Math.max(1, cnt[i]!);
  return out;
}

/**
 * Difference hash: 64 bits describing brightness gradients. Robust to resizing and
 * re-compression, sensitive to changed content. Returned as 16 hex chars.
 */
export function dHash(r: Raster): string {
  const g = grayGrid(r, 9, 8);
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g[y * 9 + x]! > g[y * 9 + x + 1]! ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Nearest-neighbour resize, used to bring two images to a common size for diffing. */
export function resize(r: Raster, w: number, h: number): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(r.height - 1, Math.floor((y * r.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(r.width - 1, Math.floor((x * r.width) / w));
      const s = (sy * r.width + sx) * 4;
      const d = (y * w + x) * 4;
      data[d] = r.data[s]!; data[d + 1] = r.data[s + 1]!; data[d + 2] = r.data[s + 2]!; data[d + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Maps 0..1 to a perceptual heat colour (dark blue -> yellow -> white). */
export function heatColor(v: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, v));
  if (t < 0.33) return [10, 10 + t * 300, 60 + t * 400];
  if (t < 0.66) return [(t - 0.33) * 700, 110 + (t - 0.33) * 300, 190 - (t - 0.33) * 500];
  return [235 + (t - 0.66) * 60, 210 + (t - 0.66) * 130, (t - 0.66) * 700];
}
