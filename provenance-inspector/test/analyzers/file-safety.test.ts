import { describe, expect, it } from 'vitest';
import { MagicByteDetector } from '../../src/analyzers/file-type.js';
import { docx, fakeExe, fixtureBytes, ids, inspect, latin1Bytes } from '../helpers.js';

describe('type detection by content', () => {
  const d = new MagicByteDetector();
  it.each([
    ['IMG_0003.jpg', 'jpeg'],
  ])('%s is %s', (f, id) => expect(d.detect(fixtureBytes(f)).id).toBe(id));

  it('recognises executables, PDFs, Office files and plain text', () => {
    expect(d.detect(fakeExe()).family).toBe('executable');
    expect(d.detect(latin1Bytes('%PDF-1.7\n')).id).toBe('pdf');
    expect(d.detect(docx()).id).toBe('docx');
    expect(d.detect(docx({ macros: true })).id).toBe('docm');
    expect(d.detect(latin1Bytes('name,amount\nA,1\n')).id).toBe('text');
  });

  it('does not crash on a truncated ZIP', () => {
    expect(d.detect(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2])).id).toBe('zip');
  });
});

describe('disguised files', () => {
  it('flags an executable named like a PDF as dangerous', async () => {
    const r = await inspect('Rechnung_2026.pdf', fakeExe(), 'application/pdf');
    expect(r.assessment.verdict).toBe('dangerous');
    expect(r.findings.find((f) => f.id === 'type.executable')).toMatchObject({ severity: 'critical', title: 'Executable disguised as .pdf' });
  });

  it('flags double extensions', async () => {
    const r = await inspect('Bewerbung.pdf.exe', fakeExe());
    expect(ids(r)).toContain('name.double-extension');
  });

  it('flags right-to-left override tricks in the name', async () => {
    const r = await inspect('invoice\u202Efdp.exe', fakeExe());
    expect(ids(r)).toContain('name.bidi');
    expect(r.assessment.verdict).toBe('dangerous');
  });

  it('reports a renamed but harmless file as a mismatch, not as dangerous', async () => {
    const r = await inspect('photo.png', fixtureBytes('IMG_0003.jpg'), 'image/png');
    expect(ids(r)).toContain('type.mismatch');
    expect(r.assessment.verdict).not.toBe('dangerous');
  });

  it('flags SVG images with scripts', async () => {
    const svg = latin1Bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>location="https://evil.example"</script></svg>');
    const r = await inspect('logo.svg', svg);
    expect(r.findings.find((f) => f.id === 'markup.script')?.severity).toBe('critical');
  });
});

describe('Office documents', () => {
  it('finds macros', async () => {
    const r = await inspect('Lebenslauf.docx', docx({ macros: true }));
    expect(ids(r)).toContain('office.macros');
    expect(r.assessment.verdict).toBe('dangerous');
  });

  it('finds remote template injection', async () => {
    const r = await inspect('angebot.docx', docx({ remoteTemplate: 'http://203.0.113.9/t.dotm' }));
    expect(r.findings.find((f) => f.id === 'office.remote-template')?.data?.['target']).toBe('http://203.0.113.9/t.dotm');
  });

  it('finds DDE fields', async () => {
    expect(ids(await inspect('a.docx', docx({ dde: true })))).toContain('office.dde');
  });

  it('a plain document has no red flags', async () => {
    const r = await inspect('brief.docx', docx());
    expect(r.assessment.verdict).toBe('no-red-flags');
  });
});

describe('PDF documents', () => {
  const pdf = (body: string) => latin1Bytes(`%PDF-1.7\n${body}\n%%EOF\n`);

  it('flags JavaScript that runs on open, launch actions and attachments', async () => {
    const r = await inspect('rechnung.pdf', pdf('1 0 obj << /OpenAction 2 0 R >> endobj 2 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj 3 0 obj << /Type /Action /S /Launch >> endobj /EmbeddedFile'));
    expect(r.findings.find((f) => f.id === 'pdf.javascript')?.severity).toBe('critical');
    expect(ids(r)).toEqual(expect.arrayContaining(['pdf.launch', 'pdf.attachments']));
    expect(r.assessment.verdict).toBe('dangerous');
  });

  it('sees through hex-escaped names (/J#61vaScript)', async () => {
    const r = await inspect('x.pdf', pdf('<< /S /J#61vaScript /JS (x) >>'));
    expect(ids(r)).toContain('pdf.javascript');
  });

  it('reports editing history, online editors and impossible dates', async () => {
    const body = '<< /Producer (iLovePDF) /CreationDate (D:20260301100000+01\'00\') /ModDate (D:20250101100000Z) >>\n%%EOF\n<< /Annot >>';
    const r = await inspect('kontoauszug.pdf', pdf(body));
    expect(ids(r)).toEqual(expect.arrayContaining(['pdf.incremental', 'pdf.online-editor', 'pdf.date-inconsistent']));
    expect(r.assessment.verdict).toBe('needs-review');
  });
});

describe('container tricks', () => {
  it('finds a ZIP archive appended to a JPEG', async () => {
    const jpg = fixtureBytes('IMG_0003.jpg');
    const polyglot = new Uint8Array([...jpg, ...docx()]);
    const r = await inspect('cat.jpg', polyglot);
    expect(r.findings.find((f) => f.id === 'container.trailing')).toMatchObject({ severity: 'critical', title: 'ZIP archive hidden after the image data' });
  });

  it('a normal JPEG has no trailing data finding', async () => {
    expect(ids(await inspect('a.jpg', fixtureBytes('IMG_0003.jpg')))).not.toContain('container.trailing');
  });
});
