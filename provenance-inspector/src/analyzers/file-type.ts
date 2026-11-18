// Content-based type detection ("magic bytes") and checks that compare it with what the
// file name and declared MIME type claim. This is how disguised malware is spotted:
// "Rechnung.pdf.exe", "photo.jpg" that is really a script, or right-to-left override tricks.

import type { Analyzer, DetectedType, FileContext, TypeDetector } from '../core/inspect-file.js';
import { finding, type Finding } from '../core/findings.js';
import { ascii, startsWith } from './bytes.js';

type Rule = Omit<DetectedType, 'id'> & { id: string; test: (b: Uint8Array) => boolean };

const T = (id: string, label: string, family: DetectedType['family'], mime: string | null, extensions: string[], test: Rule['test']): Rule =>
  ({ id, label, family, mime, extensions, test });

// Order matters: more specific signatures first.
const RULES: Rule[] = [
  T('pe-executable', 'Windows executable (PE)', 'executable', 'application/vnd.microsoft.portable-executable',
    ['exe', 'dll', 'scr', 'com', 'sys', 'cpl'], (b) => startsWith(b, [0x4d, 0x5a])),
  T('elf-executable', 'Linux executable (ELF)', 'executable', 'application/x-elf', ['elf', 'so', 'bin', ''], (b) => startsWith(b, [0x7f, 0x45, 0x4c, 0x46])),
  T('macho-executable', 'macOS executable (Mach-O)', 'executable', 'application/x-mach-binary', ['', 'dylib'],
    (b) => [[0xcf, 0xfa, 0xed, 0xfe], [0xce, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((s) => startsWith(b, s))),
  T('windows-shortcut', 'Windows shortcut (LNK)', 'executable', 'application/x-ms-shortcut', ['lnk'],
    (b) => startsWith(b, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])),
  T('msi', 'Windows installer / legacy Office (OLE2)', 'document', 'application/x-ole-storage',
    ['doc', 'xls', 'ppt', 'msi', 'msg'], (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
  T('pdf', 'PDF document', 'document', 'application/pdf', ['pdf'], (b) => ascii(b, 0, 1024).includes('%PDF-')),
  T('jpeg', 'JPEG image', 'image', 'image/jpeg', ['jpg', 'jpeg', 'jfif', 'jpe'], (b) => startsWith(b, [0xff, 0xd8, 0xff])),
  T('png', 'PNG image', 'image', 'image/png', ['png'], (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  T('gif', 'GIF image', 'image', 'image/gif', ['gif'], (b) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a'),
  T('webp', 'WebP image', 'image', 'image/webp', ['webp'], (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'),
  T('heic', 'HEIC/HEIF image', 'image', 'image/heic', ['heic', 'heif'], (b) => ascii(b, 4, 8) === 'ftyp' && /hei[cx]|mif1|msf1/.test(ascii(b, 8, 12))),
  T('avif', 'AVIF image', 'image', 'image/avif', ['avif'], (b) => ascii(b, 4, 8) === 'ftyp' && ascii(b, 8, 12) === 'avif'),
  T('tiff', 'TIFF image', 'image', 'image/tiff', ['tif', 'tiff', 'dng'], (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])),
  T('mp4', 'MP4/MOV video', 'media', 'video/mp4', ['mp4', 'm4v', 'mov', 'm4a'], (b) => ascii(b, 4, 8) === 'ftyp'),
  T('wav', 'WAV audio', 'media', 'audio/wav', ['wav'], (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE'),
  T('mp3', 'MP3 audio', 'media', 'audio/mpeg', ['mp3'], (b) => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)),
  T('zip', 'ZIP archive', 'archive', 'application/zip', ['zip', 'jar', 'apk'], (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])),
  T('rar', 'RAR archive', 'archive', 'application/vnd.rar', ['rar'], (b) => ascii(b, 0, 4) === 'Rar!'),
  T('7z', '7-Zip archive', 'archive', 'application/x-7z-compressed', ['7z'], (b) => startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])),
  T('gzip', 'GZIP archive', 'archive', 'application/gzip', ['gz', 'tgz'], (b) => startsWith(b, [0x1f, 0x8b])),
  T('iso', 'Disk image (ISO)', 'archive', 'application/x-iso9660-image', ['iso', 'img'], (b) => ascii(b, 0x8001, 0x8006) === 'CD001'),
  T('rtf', 'Rich Text document', 'document', 'application/rtf', ['rtf', 'doc'], (b) => ascii(b, 0, 5) === '{\\rtf'),
  T('svg', 'SVG image (XML, can contain scripts)', 'image', 'image/svg+xml', ['svg'], (b) => /<svg[\s>]/i.test(ascii(b, 0, 2048))),
  T('html', 'HTML document', 'script', 'text/html', ['html', 'htm', 'hta'], (b) => /^\s*(<!doctype html|<html|<head|<script)/i.test(ascii(b, 0, 512))),
  T('shell-script', 'Script with interpreter line', 'script', 'text/x-shellscript', ['sh', 'py', 'pl', 'rb', ''], (b) => ascii(b, 0, 2) === '#!'),
];

// Office Open XML files are ZIP containers; their real type is decided by the content.
function refineZip(b: Uint8Array): DetectedType | null {
  const list = zipEntryNames(b);
  const has = (p: string) => list.some((n) => n.startsWith(p));
  const macro = list.some((n) => /vbaProject\.bin$/i.test(n));
  if (has('word/')) return { id: macro ? 'docm' : 'docx', label: `Word document${macro ? ' with macros' : ''}`, family: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extensions: macro ? ['docm', 'docx'] : ['docx', 'docm'] };
  if (has('xl/')) return { id: macro ? 'xlsm' : 'xlsx', label: `Excel workbook${macro ? ' with macros' : ''}`, family: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extensions: macro ? ['xlsm', 'xlsx'] : ['xlsx', 'xlsm'] };
  if (has('ppt/')) return { id: macro ? 'pptm' : 'pptx', label: `PowerPoint presentation${macro ? ' with macros' : ''}`, family: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extensions: macro ? ['pptm', 'pptx'] : ['pptx', 'pptm'] };
  if (list.includes('AndroidManifest.xml')) return { id: 'apk', label: 'Android app (APK)', family: 'executable', mime: 'application/vnd.android.package-archive', extensions: ['apk'] };
  if (list.includes('META-INF/MANIFEST.MF')) return { id: 'jar', label: 'Java archive (JAR, executable)', family: 'executable', mime: 'application/java-archive', extensions: ['jar'] };
  return null;
}

/** Reads file names from the ZIP central directory without decompressing anything. */
export function zipEntryNames(b: Uint8Array, max = 5000): string[] {
  // End of central directory record: search the last 64 KB
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let i = 0; i < Math.min(count, max) && p + 46 <= b.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    names.push(new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const UNKNOWN: DetectedType = { id: 'unknown', label: 'Unknown / plain data', family: 'unknown', mime: null, extensions: [] };

export class MagicByteDetector implements TypeDetector {
  detect(bytes: Uint8Array): DetectedType {
    const rule = RULES.find((r) => r.test(bytes));
    if (!rule) {
      const sample = ascii(bytes, 0, 512);
      // printable text without NUL bytes
      if (sample.length && !/[\x00-\x08\x0e-\x1f]/.test(sample)) return { id: 'text', label: 'Text', family: 'text', mime: 'text/plain', extensions: ['txt', 'csv', 'md', 'json', 'xml', 'log'] };
      return UNKNOWN;
    }
    const { test: _t, ...type } = rule;
    if (type.id === 'zip') {
      try { return refineZip(bytes) ?? type; } catch { return type; } // corrupt archive: keep generic type
    }
    return type;
  }
}

// --- name based tricks ---------------------------------------------------------------

const EXECUTABLE_EXT = new Set(['exe', 'scr', 'com', 'bat', 'cmd', 'pif', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'ps1', 'msi', 'lnk', 'jar', 'cpl', 'reg', 'iso', 'img', 'apk', 'app', 'sh', 'dll']);
const DECOY_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'jpg', 'jpeg', 'png', 'txt', 'mp4', 'zip', 'ppt', 'pptx', 'rtf', 'csv']);

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  return m ? m[1]!.toLowerCase() : '';
}

const A = 'file-type';

export const fileTypeAnalyzer: Analyzer = {
  id: A,
  label: 'File type check',
  appliesTo: () => true,
  async analyze(ctx: FileContext): Promise<Finding[]> {
    const out: Finding[] = [];
    const t = ctx.detectedType;
    const name = ctx.name;
    const ext = extensionOf(name);

    out.push(finding(A, {
      id: 'type.detected', category: 'file-type', severity: 'info', polarity: 'neutral',
      title: `Content is: ${t.label}`,
      detail: 'Detected from the first bytes of the file, independent of its name.',
      data: { detected: t.id, extension: ext || '(none)', declaredMime: ctx.declaredType || '(none)' },
    }));

    // Right-to-left override: "invoice_gpj.exe" displays as "invoice_exe.jpg"
    if (/[‮‭‪‫⁦-⁩]/.test(name)) {
      out.push(finding(A, {
        id: 'name.bidi', category: 'file-type', severity: 'critical', polarity: 'weakens',
        title: 'File name hides its real extension',
        detail: 'The name contains invisible Unicode direction characters (e.g. right-to-left override). This trick makes "report‮fdp.exe" look like "reportexe.pdf" and is used to disguise malware.',
      }));
    }

    const parts = name.toLowerCase().split('.');
    if (parts.length >= 3) {
      const inner = parts[parts.length - 2]!;
      if (DECOY_EXT.has(inner) && EXECUTABLE_EXT.has(ext)) {
        out.push(finding(A, {
          id: 'name.double-extension', category: 'file-type', severity: 'critical', polarity: 'weakens',
          title: `Double extension ".${inner}.${ext}"`,
          detail: `Windows hides known extensions by default, so this file appears as "…${'.' + inner}" while it is really a .${ext} file that can run code.`,
        }));
      }
    }
    if (/\s{5,}\.[a-z0-9]+$/i.test(name)) {
      out.push(finding(A, {
        id: 'name.padding', category: 'file-type', severity: 'warning', polarity: 'weakens',
        title: 'Extension pushed out of view with spaces',
        detail: 'Many spaces before the extension can hide it in narrow file lists.',
      }));
    }

    if (t.family === 'executable') {
      const looksHarmless = DECOY_EXT.has(ext) || /^(image|text|application\/pdf|video|audio)/.test(ctx.declaredType);
      out.push(finding(A, {
        id: 'type.executable', category: 'file-type', severity: looksHarmless ? 'critical' : 'warning', polarity: 'weakens',
        title: looksHarmless ? `Executable disguised as .${ext || ctx.declaredType}` : 'This is an executable program',
        detail: looksHarmless
          ? `The content is a ${t.label}, but the name or type says it is a harmless ${ext || ctx.declaredType} file. This is a classic malware delivery trick.`
          : `Running it executes code on your computer. Only open programs from sources you trust.`,
      }));
    } else if (ext && t.id !== 'unknown' && t.id !== 'text' && !t.extensions.includes(ext)) {
      out.push(finding(A, {
        id: 'type.mismatch', category: 'file-type', severity: 'warning', polarity: 'weakens',
        title: `Extension .${ext} does not match the content (${t.label})`,
        detail: 'Often harmless (a renamed file), but mismatches are also used to get files past filters.',
      }));
    }

    if (t.id === 'svg' || t.id === 'html') {
      const hasScript = /<script|on\w+\s*=|javascript:/i.test(new TextDecoder().decode(ctx.bytes.subarray(0, 200_000)));
      if (hasScript) {
        out.push(finding(A, {
          id: 'markup.script', category: 'active-content', severity: t.id === 'svg' ? 'critical' : 'warning', polarity: 'weakens',
          title: `${t.id === 'svg' ? 'Image' : 'HTML file'} contains JavaScript`,
          detail: t.id === 'svg'
            ? 'SVG "images" with scripts run code when opened in a browser and are a popular phishing attachment.'
            : 'HTML attachments with scripts are often used to show fake login pages offline.',
        }));
      }
    }
    return out;
  },
};
