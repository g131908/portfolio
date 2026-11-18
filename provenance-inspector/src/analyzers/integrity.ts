// Fingerprints that let anyone check later whether a file is bit-for-bit the same.

import type { Analyzer, FileContext } from '../core/inspect-file.js';
import { finding, type Finding } from '../core/findings.js';
import { sha256Hex } from './image-math.js';

export const integrityAnalyzer: Analyzer = {
  id: 'integrity',
  label: 'Fingerprint',
  appliesTo: () => true,
  async analyze(ctx: FileContext): Promise<Finding[]> {
    const hash = await sha256Hex(ctx.bytes);
    return [finding('integrity', {
      id: 'integrity.sha256', category: 'integrity', severity: 'info', polarity: 'neutral',
      title: 'SHA-256 fingerprint',
      detail: 'Changes if even one bit of the file changes. Use it to compare with a hash published by the original source, or to look the file up in malware databases such as VirusTotal.',
      data: { sha256: hash },
    })];
  },
};
