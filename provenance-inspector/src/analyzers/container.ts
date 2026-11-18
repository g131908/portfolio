// Container anomalies: data hidden after the logical end of an image, or a second file
// format hidden inside (polyglots such as a JPEG that is also a ZIP archive).

import type { Analyzer, FileContext } from '../core/inspect-file.js';
import { finding, type Finding } from '../core/findings.js';
import { formatBytes, lastIndexOf, startsWith, u32be } from './bytes.js';
import { parseJpeg } from './jpeg.js';

const A = 'container';

/** Offset just after the logical end of the image, or null if unknown. */
export function logicalEnd(ctx: FileContext): number | null {
  const b = ctx.bytes;
  if (ctx.detectedType.id === 'jpeg') {
    // Walk the real segment structure: a simple "last FFD9" search would be fooled by
    // a second JPEG appended to the file.
    return parseJpeg(b).end;
  }
  if (ctx.detectedType.id === 'png') {
    let p = 8;
    while (p + 12 <= b.length) {
      const len = u32be(b, p);
      const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!);
      p += 12 + len;
      if (type === 'IEND') return p;
    }
    return null;
  }
  if (ctx.detectedType.id === 'gif') {
    const t = lastIndexOf(b, [0x3b]);
    return t < 0 ? null : t + 1;
  }
  return null;
}

const EMBEDDED_SIGNATURES: Array<{ label: string; sig: number[]; risky: boolean }> = [
  { label: 'ZIP archive', sig: [0x50, 0x4b, 0x03, 0x04], risky: true },
  { label: 'Windows executable', sig: [0x4d, 0x5a, 0x90, 0x00], risky: true },
  { label: 'RAR archive', sig: [0x52, 0x61, 0x72, 0x21], risky: true },
  { label: 'PDF document', sig: [0x25, 0x50, 0x44, 0x46], risky: false },
  { label: 'JPEG image', sig: [0xff, 0xd8, 0xff], risky: false },
];

export const containerAnalyzer: Analyzer = {
  id: A,
  label: 'Container structure check',
  appliesTo: (ctx) => ['jpeg', 'png', 'gif'].includes(ctx.detectedType.id),
  async analyze(ctx: FileContext): Promise<Finding[]> {
    const end = logicalEnd(ctx);
    if (end === null) {
      return [finding(A, {
        id: 'container.truncated', category: 'structure', severity: 'notice', polarity: 'weakens',
        title: 'Image has no proper end marker',
        detail: 'The file may be truncated or damaged.',
      })];
    }
    const trailing = ctx.bytes.length - end;
    if (trailing <= 16) return [];
    const tail = ctx.bytes.subarray(end);
    const hidden = EMBEDDED_SIGNATURES.find((s) => {
      for (let i = 0; i < Math.min(tail.length, 4096); i++) if (startsWith(tail, s.sig, i)) return true;
      return false;
    });
    const out: Finding[] = [];
    out.push(finding(A, {
      id: 'container.trailing', category: 'structure',
      severity: hidden?.risky ? 'critical' : 'warning', polarity: 'weakens',
      title: hidden ? `${hidden.label} hidden after the image data` : `${formatBytes(trailing)} of extra data after the image`,
      detail: hidden
        ? 'The file shows a normal picture but carries a second file appended to it. This technique is used to smuggle payloads past filters.'
        : 'Image viewers ignore data after the end marker. Some cameras and apps write extra data here (e.g. motion photos), but it can also hide content.',
      data: { trailingBytes: trailing, offset: end },
    }));
    return out;
  },
};
