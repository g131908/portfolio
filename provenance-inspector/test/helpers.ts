import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { defaultAnalyzers, MagicByteDetector } from '../src/analyzers/index.js';
import type { ManifestStore, ProvenanceReader } from '../src/analyzers/provenance.js';
import { InspectFile, type InspectionReport } from '../src/core/inspect-file.js';

export const fixtureBytes = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
export const fixtureJson = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** Stand-in for the WebAssembly C2PA SDK: answers with recorded SDK output per file. */
export class RecordedProvenance implements ProvenanceReader {
  constructor(private readonly byLength: Map<number, ManifestStore | null> = new Map()) {}
  async read(bytes: Uint8Array): Promise<ManifestStore | null> { return this.byLength.get(bytes.length) ?? null; }
}

export async function inspect(name: string, bytes: Uint8Array, declaredType = '', provenance: ProvenanceReader | null = null): Promise<InspectionReport> {
  return new InspectFile(new MagicByteDetector(), defaultAnalyzers(provenance)).execute({ name, declaredType, bytes, lastModified: null });
}

export const ids = (r: InspectionReport) => r.findings.map((f) => f.id);

export const latin1Bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

export function fakeExe(): Uint8Array {
  const b = new Uint8Array(1024);
  b.set([0x4d, 0x5a, 0x90, 0x00]);
  b.set(latin1Bytes('This program cannot be run in DOS mode.'), 78);
  return b;
}

export function docx(opts: { macros?: boolean; remoteTemplate?: string; dde?: boolean } = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r>${opts.dde ? '<w:instrText>DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k calc"</w:instrText>' : '<w:t>Hello</w:t>'}</w:r></w:p></w:body></w:document>`),
  };
  if (opts.remoteTemplate) {
    files['word/_rels/settings.xml.rels'] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="${opts.remoteTemplate}" TargetMode="External"/></Relationships>`);
  }
  if (opts.macros) files['word/vbaProject.bin'] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]);
  return zipSync(files);
}
