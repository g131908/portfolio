// Compare a suspicious image with a known original: same file? same picture? what changed?

import { dHash, hammingHex, heatColor, resize, sha256Hex, type Raster } from './image-math.js';

export interface Comparison {
  readonly identicalBytes: boolean;
  readonly hashDistance: number;
  readonly verdict: 'identical-file' | 'same-picture' | 'modified' | 'different-picture';
  readonly sizeA: string;
  readonly sizeB: string;
  readonly aspectChanged: boolean;
  /** Share of the picture that differs clearly (0..1) */
  readonly changedShare: number;
  readonly changedBox: { x: number; y: number; w: number; h: number } | null;
  readonly diff: { width: number; height: number; rgba: Uint8ClampedArray };
}

const MAX_SIDE = 640;

export async function compareImages(bytesA: Uint8Array, a: Raster, bytesB: Uint8Array, b: Raster): Promise<Comparison> {
  const [ha, hb] = await Promise.all([sha256Hex(bytesA), sha256Hex(bytesB)]);
  const distance = hammingHex(dHash(a), dHash(b));
  const scale = Math.min(1, MAX_SIDE / Math.max(a.width, a.height));
  const w = Math.max(1, Math.round(a.width * scale));
  const h = Math.max(1, Math.round(a.height * scale));
  const ra = resize(a, w, h);
  const rb = resize(b, w, h);

  const rgba = new Uint8ClampedArray(w * h * 4);
  let changed = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const d = Math.max(Math.abs(ra.data[i]! - rb.data[i]!), Math.abs(ra.data[i + 1]! - rb.data[i + 1]!), Math.abs(ra.data[i + 2]! - rb.data[i + 2]!));
    // compression noise stays below ~25 levels; real edits are usually far above
    const v = d < 25 ? 0 : Math.min(1, (d - 25) / 80);
    const [r, g, bl] = heatColor(v);
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = bl; rgba[i + 3] = 255;
    if (d >= 40) {
      changed++;
      const x = p % w, y = Math.floor(p / w);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const share = changed / (w * h);
  const aspectChanged = Math.abs(a.width / a.height - b.width / b.height) > 0.02;
  const verdict: Comparison['verdict'] = ha === hb ? 'identical-file'
    : distance > 20 ? 'different-picture'
      : share > 0.002 || aspectChanged ? 'modified' : 'same-picture';
  return {
    identicalBytes: ha === hb, hashDistance: distance, verdict,
    sizeA: `${a.width}×${a.height}`, sizeB: `${b.width}×${b.height}`, aspectChanged,
    changedShare: share,
    changedBox: maxX >= 0 ? { x: minX / w, y: minY / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h } : null,
    diff: { width: w, height: h, rgba },
  };
}
