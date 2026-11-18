// Signal-level forensics for JPEG photos.
//
// Error Level Analysis (ELA): re-save the image at a known quality and measure how much each
// region changes. Areas that were pasted in or retouched often went through a different
// compression history and stand out. ELA is a visual aid with many false positives (edges,
// text, saturated colours), so it never produces more than a "warning" on its own.
//
// Thumbnail check: cameras embed a small preview. Editors that do not update it leave the
// ORIGINAL picture inside the edited file.

import exifr from 'exifr';
import type { Analyzer, FileContext } from '../core/inspect-file.js';
import { finding, type Finding } from '../core/findings.js';
import { dHash, decodeJpeg, encodeJpeg, hammingHex, heatColor, MAX_MEGAPIXELS, type Raster } from './image-math.js';

const A = 'forensics';
export const ELA_QUALITY = 90;
const BLOCK = 16;

export interface ElaResult {
  readonly width: number;
  readonly height: number;
  /** RGBA heatmap, same size as the image */
  readonly heatmap: Uint8ClampedArray;
  readonly blocksX: number;
  readonly blocksY: number;
  readonly blockMeans: Float32Array;
  readonly medianBlock: number;
  readonly p99Block: number;
  /** Largest connected group of unusually bright blocks. */
  readonly hotspot: { blocks: number; share: number; meanRatio: number; x: number; y: number; w: number; h: number } | null;
}

function quantile(sorted: Float32Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

export function errorLevelAnalysis(img: Raster, quality = ELA_QUALITY): ElaResult {
  const resaved = decodeJpeg(encodeJpeg(img, quality));
  const { width, height } = img;
  const diff = new Float32Array(width * height);
  let maxDiff = 1;
  for (let i = 0, p = 0; p < diff.length; i += 4, p++) {
    const d = Math.max(Math.abs(img.data[i]! - resaved.data[i]!), Math.abs(img.data[i + 1]! - resaved.data[i + 1]!), Math.abs(img.data[i + 2]! - resaved.data[i + 2]!));
    diff[p] = d;
    if (d > maxDiff) maxDiff = d;
  }

  const blocksX = Math.ceil(width / BLOCK);
  const blocksY = Math.ceil(height / BLOCK);
  const blockMeans = new Float32Array(blocksX * blocksY);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let sum = 0;
      let n = 0;
      for (let y = by * BLOCK; y < Math.min(height, (by + 1) * BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(width, (bx + 1) * BLOCK); x++) { sum += diff[y * width + x]!; n++; }
      }
      blockMeans[by * blocksX + bx] = sum / Math.max(1, n);
    }
  }
  const sorted = Float32Array.from(blockMeans).sort();
  const medianBlock = quantile(sorted, 0.5);
  const p99Block = quantile(sorted, 0.99);

  // Heatmap: scale so that the 99th percentile block maps to full brightness.
  const scale = 1 / Math.max(2, p99Block * 1.4);
  const heatmap = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < diff.length; p++) {
    const [r, g, b] = heatColor(diff[p]! * scale);
    heatmap[p * 4] = r; heatmap[p * 4 + 1] = g; heatmap[p * 4 + 2] = b; heatmap[p * 4 + 3] = 255;
  }

  // Hot blocks: clearly above the typical error level of this image.
  const threshold = Math.max(medianBlock * 2.2, medianBlock + 1);
  const hot = new Uint8Array(blockMeans.length);
  for (let i = 0; i < hot.length; i++) hot[i] = blockMeans[i]! > threshold ? 1 : 0;
  const seen = new Uint8Array(hot.length);
  let best: ElaResult['hotspot'] = null;
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let count = 0, sum = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % blocksX, y = Math.floor(i / blocksX);
      count++; sum += blockMeans[i]!;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= blocksX || ny >= blocksY) continue;
        const j = ny * blocksX + nx;
        if (hot[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (!best || count > best.blocks) {
      best = {
        blocks: count, share: count / hot.length, meanRatio: sum / count / Math.max(0.5, medianBlock),
        x: minX * BLOCK, y: minY * BLOCK, w: (maxX - minX + 1) * BLOCK, h: (maxY - minY + 1) * BLOCK,
      };
    }
  }
  return { width, height, heatmap, blocksX, blocksY, blockMeans, medianBlock, p99Block, hotspot: best };
}

// Cache so the UI can show the heatmap without computing ELA twice for the same file.
const elaCache = new WeakMap<Uint8Array, ElaResult>();
export function cachedEla(bytes: Uint8Array): ElaResult {
  let r = elaCache.get(bytes);
  if (!r) {
    r = errorLevelAnalysis(decodeJpeg(bytes));
    elaCache.set(bytes, r);
  }
  return r;
}

export const forensicsAnalyzer: Analyzer = {
  id: A,
  label: 'Image forensics',
  appliesTo: (ctx) => ctx.detectedType.id === 'jpeg',
  async analyze(ctx: FileContext): Promise<Finding[]> {
    const out: Finding[] = [];
    let ela: ElaResult;
    try {
      ela = cachedEla(ctx.bytes);
    } catch (err) {
      return [finding(A, {
        id: 'forensics.skipped', category: 'forensics', severity: 'info', polarity: 'neutral',
        title: 'Pixel analysis skipped',
        detail: /maxResolution|memory/i.test(String(err)) ? `Images above ${MAX_MEGAPIXELS} megapixels are not analysed.` : `The image data could not be decoded (${(err as Error).message}).`,
      })];
    }

    const h = ela.hotspot;
    const localized = h && h.share >= 0.002 && h.share <= 0.25 && h.meanRatio >= 2.5;
    out.push(finding(A, {
      id: localized ? 'forensics.ela-region' : 'forensics.ela-uniform', category: 'forensics',
      severity: localized ? (h.meanRatio >= 4 ? 'warning' : 'notice') : 'info',
      polarity: localized ? 'weakens' : 'neutral',
      title: localized
        ? `Region with unusual compression error (${Math.round(h.share * 100)}% of the image)`
        : 'Compression error is evenly distributed',
      detail: localized
        ? 'One area reacts much more strongly to re-compression than the rest. This happens when content was pasted in or retouched, but also around sharp text, logos and very bright edges. Compare with the heatmap.'
        : 'No area stands out in the error level analysis. Note that saving an image again many times hides earlier edits.',
      data: localized
        ? { x: h.x, y: h.y, width: h.w, height: h.h, contrast: Math.round(h.meanRatio * 10) / 10 }
        : { medianError: Math.round(ela.medianBlock * 10) / 10, p99Error: Math.round(ela.p99Block * 10) / 10 },
    }));

    // Embedded thumbnail vs. main image
    const thumbBytes = await exifr.thumbnail(ctx.bytes).catch(() => undefined);
    if (thumbBytes && thumbBytes.length > 100) {
      try {
        const thumb = decodeJpeg(new Uint8Array(thumbBytes));
        const main = decodeJpeg(ctx.bytes);
        const ratioMain = main.width / main.height;
        const ratioThumb = thumb.width / thumb.height;
        const distance = hammingHex(dHash(main), dHash(thumb));
        // Rotated thumbnails or different aspect ratios make the hash comparison meaningless.
        if (Math.abs(ratioMain - ratioThumb) / ratioMain > 0.08 && Math.abs(1 / ratioMain - ratioThumb) * ratioMain > 0.08) {
          out.push(finding(A, {
            id: 'forensics.thumb-aspect', category: 'forensics', severity: 'notice', polarity: 'weakens',
            title: 'Embedded preview has a different shape',
            detail: 'The thumbnail stored by the camera has another aspect ratio than the image, so the picture was probably cropped after it was taken.',
            data: { image: `${main.width}×${main.height}`, thumbnail: `${thumb.width}×${thumb.height}` },
          }));
        } else if (distance > 18) {
          out.push(finding(A, {
            id: 'forensics.thumb-mismatch', category: 'forensics', severity: 'warning', polarity: 'weakens',
            title: 'Embedded preview shows a different picture',
            detail: 'The thumbnail inside the file does not match the visible image. This happens when an image is edited with a tool that does not update the preview, which then still shows the original.',
            data: { hashDistance: distance },
          }));
        } else {
          out.push(finding(A, {
            id: 'forensics.thumb-match', category: 'forensics', severity: 'info', polarity: 'supports',
            title: 'Embedded preview matches the image',
            detail: 'The stored thumbnail shows the same picture.',
            data: { hashDistance: distance },
          }));
        }
      } catch { /* undecodable thumbnail: nothing to compare */ }
    }
    return out;
  },
};
