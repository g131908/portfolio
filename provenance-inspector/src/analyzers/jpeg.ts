// JPEG structure: segments, embedded metadata blocks and quantization tables.
// The quantization table is a fingerprint of the software that last saved the image.

import type { Analyzer, FileContext } from '../core/inspect-file.js';
import { finding, type Finding } from '../core/findings.js';
import { ascii, u16be } from './bytes.js';

const A = 'jpeg';

export interface JpegSegment {
  readonly marker: number;
  readonly offset: number;
  readonly length: number;
  /** For APPn segments: the identifier string, e.g. "Exif", "http://ns.adobe.com/xap/1.0/", "JFIF". */
  readonly id: string;
}

export interface JpegStructure {
  readonly segments: readonly JpegSegment[];
  /** Luminance quantization table in zig-zag order (64 values), if present. */
  readonly lumaTable: readonly number[] | null;
  readonly progressive: boolean;
  /** Offset just after EOI, or null if not found. */
  readonly end: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

/** Walks the segment list. Throws RangeError on structurally broken files. */
export function parseJpeg(b: Uint8Array): JpegStructure {
  const segments: JpegSegment[] = [];
  let lumaTable: number[] | null = null;
  let progressive = false;
  let width: number | null = null;
  let height: number | null = null;
  let p = 2;
  const MAX_SEGMENTS = 2000;

  while (p + 2 <= b.length && segments.length < MAX_SEGMENTS) {
    if (b[p] !== 0xff) throw new RangeError(`expected marker at ${p}`);
    const marker = b[p + 1]!;
    if (marker === 0xff) { p += 1; continue; } // fill byte
    if (marker === 0xd9) return { segments, lumaTable, progressive, end: p + 2, width, height };
    if (marker >= 0xd0 && marker <= 0xd7) { p += 2; continue; }
    const length = u16be(b, p + 2);
    if (length < 2) throw new RangeError('invalid segment length');
    const dataStart = p + 4;
    const id = marker >= 0xe0 && marker <= 0xef ? ascii(b, dataStart, Math.min(dataStart + 32, b.length)).split('\0')[0]! : '';
    segments.push({ marker, offset: p, length, id });

    if (marker === 0xdb) {
      // DQT may hold several tables: [Pq|Tq][64 or 128 bytes]
      let q = dataStart;
      while (q < p + 2 + length) {
        const pq = b[q]! >> 4;
        const tq = b[q]! & 0x0f;
        const size = pq ? 128 : 64;
        if (tq === 0 && !lumaTable) {
          lumaTable = [];
          for (let i = 0; i < 64; i++) lumaTable.push(pq ? u16be(b, q + 1 + i * 2) : b[q + 1 + i]!);
        }
        q += 1 + size;
      }
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      progressive ||= marker === 0xc2;
      height = u16be(b, dataStart + 1);
      width = u16be(b, dataStart + 3);
    }
    p += 2 + length;
    if (marker === 0xda) {
      // entropy-coded data: skip until a marker that is not stuffing (FF00) or a restart marker
      while (p + 1 < b.length && !(b[p] === 0xff && b[p + 1] !== 0x00 && !(b[p + 1]! >= 0xd0 && b[p + 1]! <= 0xd7))) p++;
    }
  }
  return { segments, lumaTable, progressive, end: null, width, height };
}

// IJG (libjpeg) standard luminance table in zig-zag order, the reference for "quality".
const IJG_LUMA = [16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40, 26, 24, 22, 22, 24, 49, 35, 37, 29, 40, 58, 51, 61, 60, 57, 51, 56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87, 95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92, 101, 103, 99];

export function scaledIjgTable(quality: number): number[] {
  const q = Math.min(100, Math.max(1, quality));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return IJG_LUMA.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/**
 * Estimates the IJG quality factor and whether the table is exactly an IJG table.
 * Cameras and some editors use their own tables, which is itself a useful clue.
 */
export function estimateQuality(table: readonly number[]): { quality: number; standard: boolean } {
  let best = { quality: 50, error: Infinity };
  for (let q = 1; q <= 100; q++) {
    const ref = scaledIjgTable(q);
    let err = 0;
    for (let i = 0; i < 64; i++) err += Math.abs(ref[i]! - table[i]!);
    if (err < best.error) best = { quality: q, error: err };
  }
  return { quality: best.quality, standard: best.error === 0 };
}

export const jpegAnalyzer: Analyzer = {
  id: A,
  label: 'JPEG structure check',
  appliesTo: (ctx) => ctx.detectedType.id === 'jpeg',
  async analyze(ctx: FileContext): Promise<Finding[]> {
    const s = parseJpeg(ctx.bytes);
    const out: Finding[] = [];
    const ids = s.segments.map((x) => x.id);

    if (s.lumaTable) {
      const { quality, standard } = estimateQuality(s.lumaTable);
      out.push(finding(A, {
        id: 'jpeg.quality', category: 'forensics', severity: 'info', polarity: 'neutral',
        title: `Compression quality ≈ ${quality}${standard ? ' (standard libjpeg table)' : ' (custom table)'}`,
        detail: standard
          ? 'Standard tables are used by most editors, browsers and social media when they re-save an image. Original camera files usually use custom tables.'
          : 'Custom quantization tables are typical for camera firmware and some professional software.',
        data: { quality, standardTable: standard, progressive: s.progressive },
      }));
    }
    if (s.segments.some((x) => x.marker === 0xed && x.id.startsWith('Photoshop'))) {
      out.push(finding(A, {
        id: 'jpeg.photoshop', category: 'metadata', severity: 'notice', polarity: 'weakens',
        title: 'Saved with Adobe Photoshop',
        detail: 'The file contains a Photoshop resource block, so it was opened and saved in Photoshop or a compatible editor.',
      }));
    }
    if (s.segments.some((x) => x.marker === 0xeb && (x.id === 'JP' || ascii(ctx.bytes, x.offset + 4, x.offset + 40).includes('jumb')))) {
      out.push(finding(A, {
        id: 'jpeg.jumbf', category: 'provenance', severity: 'info', polarity: 'neutral',
        title: 'Contains a JUMBF block (content credentials)',
        detail: 'C2PA content credentials are stored in JUMBF boxes. They are verified separately below.',
      }));
    }
    if (!ids.includes('Exif') && !ids.some((i) => i.startsWith('http://ns.adobe.com/xap'))) {
      out.push(finding(A, {
        id: 'jpeg.no-metadata', category: 'metadata', severity: 'notice', polarity: 'weakens',
        title: 'No EXIF or XMP metadata',
        detail: 'Metadata was removed. Messengers and social networks do this automatically, so it is common, but it also removes clues about the origin.',
      }));
    }
    return out;
  },
};
