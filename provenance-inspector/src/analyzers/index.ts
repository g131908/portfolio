// Default analyzer set. The provenance analyzer needs a platform-specific C2PA reader.
import type { Analyzer } from '../core/inspect-file.js';
import { containerAnalyzer } from './container.js';
import { fileTypeAnalyzer } from './file-type.js';
import { forensicsAnalyzer } from './forensics.js';
import { integrityAnalyzer } from './integrity.js';
import { jpegAnalyzer } from './jpeg.js';
import { metadataAnalyzer } from './metadata.js';
import { officeAnalyzer } from './office.js';
import { pdfAnalyzer } from './pdf.js';
import { createProvenanceAnalyzer, type ProvenanceReader } from './provenance.js';

export { MagicByteDetector } from './file-type.js';

export function defaultAnalyzers(provenance: ProvenanceReader | null): Analyzer[] {
  return [
    fileTypeAnalyzer, officeAnalyzer, pdfAnalyzer, containerAnalyzer, jpegAnalyzer,
    metadataAnalyzer, forensicsAnalyzer, integrityAnalyzer,
    ...(provenance ? [createProvenanceAnalyzer(provenance)] : []),
  ];
}
