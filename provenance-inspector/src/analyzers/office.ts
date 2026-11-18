// Office documents: the most common malware carrier in phishing e-mails.
// Checks for macros, remote template injection, DDE fields and embedded objects.

import { unzipSync } from 'fflate';
import type { Analyzer, FileContext } from '../core/inspect-file.js';
import { finding, type Finding } from '../core/findings.js';
import { latin1 } from './bytes.js';
import { zipEntryNames } from './file-type.js';

const A = 'office';
const OOXML = new Set(['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm']);
const MAX_XML_BYTES = 20 * 1024 * 1024; // zip-bomb guard: never inflate more than this

export const officeAnalyzer: Analyzer = {
  id: A,
  label: 'Office document check',
  appliesTo: (ctx) => OOXML.has(ctx.detectedType.id) || ctx.detectedType.id === 'msi' || ctx.detectedType.id === 'rtf',
  async analyze(ctx: FileContext): Promise<Finding[]> {
    if (ctx.detectedType.id === 'msi') return legacyOle(ctx.bytes);
    if (ctx.detectedType.id === 'rtf') return rtf(ctx.bytes);
    return ooxml(ctx.bytes);
  },
};

function ooxml(bytes: Uint8Array): Finding[] {
  const out: Finding[] = [];
  const names = zipEntryNames(bytes);

  if (names.some((n) => /vbaProject\.bin$/i.test(n))) {
    out.push(finding(A, {
      id: 'office.macros', category: 'active-content', severity: 'critical', polarity: 'weakens',
      title: 'Contains VBA macros',
      detail: 'Macros can run arbitrary code when the document is opened and "Enable content" is clicked. Most legitimate documents sent by e-mail do not need them.',
    }));
  }
  const embedded = names.filter((n) => /\/embeddings\//i.test(n));
  if (embedded.length) {
    const risky = embedded.filter((n) => /\.(bin|exe|js|vbs|hta|lnk|scr|bat|ps1)$/i.test(n) || /oleObject/i.test(n));
    out.push(finding(A, {
      id: 'office.embedded', category: 'active-content', severity: risky.length ? 'warning' : 'notice', polarity: 'weakens',
      title: `${embedded.length} embedded object${embedded.length > 1 ? 's' : ''}`,
      detail: risky.length
        ? 'OLE objects or packaged files are embedded. Double-clicking them can launch programs.'
        : 'Other documents are embedded (e.g. a spreadsheet inside a presentation).',
      data: { files: embedded.slice(0, 5).join(', ') },
    }));
  }

  // Only inflate the small XML parts we need, with a total size budget.
  let budget = MAX_XML_BYTES;
  let parts: Record<string, Uint8Array> = {};
  try {
    parts = unzipSync(bytes, {
      filter: (f) => {
        const wanted = /\.rels$/i.test(f.name) || /^(word\/document|word\/settings|xl\/externalLinks\/.*)\.xml$/i.test(f.name);
        if (!wanted || f.originalSize > budget) return false;
        budget -= f.originalSize;
        return true;
      },
    });
  } catch (err) {
    out.push(finding(A, {
      id: 'office.corrupt', category: 'structure', severity: 'warning', polarity: 'weakens',
      title: 'Archive structure is damaged',
      detail: `The document could not be unpacked (${(err as Error).message}). Damaged containers are sometimes used to confuse scanners.`,
    }));
    return out;
  }
  const text = (n: string) => new TextDecoder().decode(parts[n]);

  const external: string[] = [];
  for (const n of Object.keys(parts).filter((x) => x.endsWith('.rels'))) {
    for (const m of text(n).matchAll(/<Relationship\b[^>]*>/g)) {
      const rel = m[0];
      if (!/TargetMode="External"/i.test(rel)) continue;
      const type = /Type="[^"]*\/([^"/]+)"/.exec(rel)?.[1] ?? 'unknown';
      const target = /Target="([^"]+)"/.exec(rel)?.[1] ?? '';
      external.push(`${type}: ${target}`);
      if (/attachedTemplate|oleObject|frame|subDocument/i.test(type)) {
        out.push(finding(A, {
          id: 'office.remote-template', category: 'active-content', severity: 'critical', polarity: 'weakens',
          title: `Loads remote content when opened (${type})`,
          detail: 'The document fetches a template or object from the internet on open. This "template injection" is used to pull in macros after the file passed e-mail filters.',
          data: { target: target.slice(0, 200) },
        }));
      }
    }
  }
  const hyperlinks = external.filter((e) => e.startsWith('hyperlink'));
  if (hyperlinks.length) {
    out.push(finding(A, {
      id: 'office.links', category: 'structure', severity: 'info', polarity: 'neutral',
      title: `${hyperlinks.length} external link${hyperlinks.length > 1 ? 's' : ''}`,
      detail: 'Check where links point before clicking them.',
      data: { first: hyperlinks[0]!.replace(/^hyperlink: /, '').slice(0, 200) },
    }));
  }

  const doc = parts['word/document.xml'] ? text('word/document.xml') : '';
  if (/\b(DDEAUTO|DDE)\b/.test(doc) && /instrText|fldSimple/.test(doc)) {
    out.push(finding(A, {
      id: 'office.dde', category: 'active-content', severity: 'critical', polarity: 'weakens',
      title: 'Contains a DDE field',
      detail: 'Dynamic Data Exchange fields can start programs (e.g. PowerShell) when the document updates its fields.',
    }));
  }
  return out;
}

function legacyOle(bytes: Uint8Array): Finding[] {
  // OLE2 directory entries are stored as UTF-16LE names; a plain scan is enough to spot macro streams.
  const s = latin1(bytes).replace(/\x00/g, '');
  const out: Finding[] = [];
  if (/_VBA_PROJECT|VBA\b|Macros/.test(s)) {
    out.push(finding(A, {
      id: 'office.legacy-macros', category: 'active-content', severity: 'critical', polarity: 'weakens',
      title: 'Legacy Office file with macros',
      detail: 'Old .doc/.xls files with VBA macros are a frequent malware carrier.',
    }));
  }
  if (/Ole10Native|Package/.test(s)) {
    out.push(finding(A, {
      id: 'office.legacy-package', category: 'active-content', severity: 'warning', polarity: 'weakens',
      title: 'Contains a packaged object',
      detail: 'Packaged objects can hide executables inside a document.',
    }));
  }
  return out;
}

function rtf(bytes: Uint8Array): Finding[] {
  const s = latin1(bytes, 0, Math.min(bytes.length, 5_000_000));
  const out: Finding[] = [];
  if (/\\object/.test(s) && /\\objdata/.test(s)) {
    out.push(finding(A, {
      id: 'rtf.object', category: 'active-content', severity: /Equation\.3|objupdate/i.test(s) ? 'critical' : 'warning', polarity: 'weakens',
      title: 'RTF with embedded OLE object',
      detail: 'Embedded objects in RTF files have been used to exploit Office vulnerabilities (e.g. the Equation Editor).',
    }));
  }
  return out;
}
