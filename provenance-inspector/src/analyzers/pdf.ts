// PDF checks: active content (JavaScript, auto actions, launch), hidden attachments,
// signatures and editing history (incremental updates, producer, dates).

import type { Analyzer, FileContext } from '../core/inspect-file.js';
import { finding, type Finding } from '../core/findings.js';
import { latin1 } from './bytes.js';

const A = 'pdf';
const SCAN_LIMIT = 60 * 1024 * 1024;

/** PDF names may be obfuscated with hex escapes: /J#61vaScript == /JavaScript */
function normalizeNames(s: string): string {
  return s.replace(/\/([A-Za-z0-9#]+)/g, (m, name: string) =>
    name.includes('#') ? `/${name.replace(/#([0-9a-fA-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)))}` : m);
}

function count(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}

/** "D:20240105143000+01'00'" -> Date */
export function parsePdfDate(v: string | undefined): Date | null {
  if (!v) return null;
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(v);
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz, th = '00', tm = '00'] = m;
  const offset = !tz || tz === 'Z' || tz === 'z' ? 'Z' : `${tz}${th}:${tm}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${offset}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function infoValue(s: string, key: string): string | undefined {
  const m = new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(s);
  return m?.[1]?.replace(/\\([()\\])/g, '$1');
}

export const pdfAnalyzer: Analyzer = {
  id: A,
  label: 'PDF check',
  appliesTo: (ctx) => ctx.detectedType.id === 'pdf',
  async analyze(ctx: FileContext): Promise<Finding[]> {
    const raw = latin1(ctx.bytes, 0, Math.min(ctx.bytes.length, SCAN_LIMIT));
    const s = normalizeNames(raw);
    const out: Finding[] = [];

    const js = count(s, /\/(JavaScript|JS)\b/g);
    const openAction = /\/OpenAction\b/.test(s) || /\/AA\s*<</.test(s);
    if (js) {
      out.push(finding(A, {
        id: 'pdf.javascript', category: 'active-content', severity: openAction ? 'critical' : 'warning', polarity: 'weakens',
        title: openAction ? 'Runs JavaScript automatically when opened' : 'Contains JavaScript',
        detail: 'Normal invoices, letters and reports do not need JavaScript. It is used for exploits and to redirect to phishing pages.',
        data: { occurrences: js, autoAction: openAction },
      }));
    }
    if (/\/Launch\b/.test(s)) {
      out.push(finding(A, {
        id: 'pdf.launch', category: 'active-content', severity: 'critical', polarity: 'weakens',
        title: 'Can launch external programs (/Launch)',
        detail: 'A Launch action asks the reader to start another program or file.',
      }));
    }
    const attachments = count(s, /\/EmbeddedFile\b/g);
    if (attachments) {
      out.push(finding(A, {
        id: 'pdf.attachments', category: 'active-content', severity: 'warning', polarity: 'weakens',
        title: `Has ${attachments} hidden file attachment${attachments > 1 ? 's' : ''}`,
        detail: 'Attachments inside PDFs are not shown on the page and can carry executables or other documents.',
      }));
    }
    if (/\/(SubmitForm|ImportData)\b/.test(s)) {
      out.push(finding(A, {
        id: 'pdf.submit', category: 'active-content', severity: 'warning', polarity: 'weakens',
        title: 'Form sends data to a server',
        detail: 'Entered data is sent to a URL. Common in phishing PDFs that ask for passwords or bank details.',
      }));
    }
    const uris = [...s.matchAll(/\/URI\s*\(([^)]{1,300})\)/g)].map((m) => m[1]!);
    if (uris.length) {
      const hosts = [...new Set(uris.map((u) => { try { return new URL(u).host; } catch { return u.slice(0, 40); } }))];
      out.push(finding(A, {
        id: 'pdf.links', category: 'structure', severity: 'info', polarity: 'neutral',
        title: `${uris.length} link${uris.length > 1 ? 's' : ''} to ${hosts.length} domain${hosts.length > 1 ? 's' : ''}`,
        detail: 'Check that link targets match the sender before clicking.',
        data: { domains: hosts.slice(0, 5).join(', ') },
      }));
    }

    // Editing history: each incremental save appends a new section ending in %%EOF.
    const eofs = count(raw, /%%EOF/g);
    const signed = /\/ByteRange\s*\[/.test(s) && /\/Sig\b/.test(s);
    if (eofs > 1) {
      out.push(finding(A, {
        id: 'pdf.incremental', category: 'structure', severity: signed ? 'warning' : 'notice', polarity: 'weakens',
        title: `Saved ${eofs} times (incremental updates)`,
        detail: signed
          ? 'The file was changed after it was first written. For signed PDFs this matters: content added after the signature is not covered by it.'
          : 'The document was modified after it was created (e.g. filled in, annotated or edited). Earlier versions are still inside the file.',
        data: { revisions: eofs },
      }));
    }
    if (signed) {
      out.push(finding(A, {
        id: 'pdf.signed', category: 'provenance', severity: 'notice', polarity: 'neutral',
        title: 'Digitally signed',
        detail: 'The PDF contains a digital signature. This tool does not validate the certificate; open it in a PDF reader to check who signed it and whether it is still valid.',
      }));
    }
    if (/\/Encrypt\b/.test(s)) {
      out.push(finding(A, {
        id: 'pdf.encrypted', category: 'structure', severity: 'notice', polarity: 'neutral',
        title: 'Encrypted',
        detail: 'Parts of the file are encrypted, so some checks could not see inside. Password-protected attachments are a common way to bypass virus scanners.',
      }));
    }
    if (/\/ObjStm\b/.test(s)) {
      out.push(finding(A, {
        id: 'pdf.objstm', category: 'structure', severity: 'info', polarity: 'neutral',
        title: 'Uses compressed object streams',
        detail: 'Some objects are compressed, so keyword checks may miss content inside them.',
      }));
    }

    const producer = infoValue(raw, 'Producer');
    const creator = infoValue(raw, 'Creator');
    const created = parsePdfDate(infoValue(raw, 'CreationDate'));
    const modified = parsePdfDate(infoValue(raw, 'ModDate'));
    if (producer || creator) {
      out.push(finding(A, {
        id: 'pdf.producer', category: 'metadata', severity: 'info', polarity: 'neutral',
        title: `Made with ${creator ?? producer}`,
        detail: 'The software that created or last saved the PDF. A bank statement made with an online PDF editor would be unusual.',
        data: { creator: creator ?? null, producer: producer ?? null },
      }));
      if (/(ilovepdf|smallpdf|sejda|pdf2go|pdfescape|pdffiller|online)/i.test(`${producer} ${creator}`)) {
        out.push(finding(A, {
          id: 'pdf.online-editor', category: 'metadata', severity: 'warning', polarity: 'weakens',
          title: 'Processed with an online PDF editor',
          detail: 'Official documents (invoices, statements, certificates) are normally produced by the issuer\'s own systems, not edited online.',
        }));
      }
    }
    if (created && modified && modified.getTime() - created.getTime() > 60_000) {
      out.push(finding(A, {
        id: 'pdf.modified-later', category: 'metadata', severity: 'notice', polarity: 'weakens',
        title: 'Modified after creation',
        detail: `Created ${created.toISOString().slice(0, 16).replace('T', ' ')} UTC, last modified ${modified.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      }));
    }
    if (created && modified && modified.getTime() < created.getTime() - 60_000) {
      out.push(finding(A, {
        id: 'pdf.date-inconsistent', category: 'metadata', severity: 'warning', polarity: 'weakens',
        title: 'Modification date is before creation date',
        detail: 'This cannot happen naturally and suggests the metadata was edited.',
      }));
    }
    return out;
  },
};
