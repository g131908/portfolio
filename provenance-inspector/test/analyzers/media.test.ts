import { describe, expect, it } from 'vitest';
import { errorLevelAnalysis } from '../../src/analyzers/forensics.js';
import { decodeJpeg, dHash, encodeJpeg, hammingHex, type Raster } from '../../src/analyzers/image-math.js';
import { estimateQuality, parseJpeg, scaledIjgTable } from '../../src/analyzers/jpeg.js';
import { pngTextChunks } from '../../src/analyzers/metadata.js';
import { provenanceFindings } from '../../src/analyzers/provenance.js';
import { fixtureBytes, fixtureJson, ids, inspect, latin1Bytes, RecordedProvenance } from '../helpers.js';

describe('JPEG structure', () => {
  it('estimates the quality of standard tables exactly', () => {
    for (const q of [50, 75, 90, 95]) expect(estimateQuality(scaledIjgTable(q))).toEqual({ quality: q, standard: true });
  });

  it('parses a real camera file', () => {
    const s = parseJpeg(fixtureBytes('IMG_0003.jpg'));
    expect(s.width).toBe(1024);
    expect(s.end).toBe(fixtureBytes('IMG_0003.jpg').length);
    expect(s.segments.some((x) => x.id === 'Exif')).toBe(true);
  });

  it('rejects broken structure instead of reading out of bounds', () => {
    expect(() => parseJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]))).not.toThrow(TypeError);
  });
});

describe('metadata', () => {
  it('reads camera, editing software and late modification from a real photo', async () => {
    const r = await inspect('IMG_0003.jpg', fixtureBytes('IMG_0003.jpg'));
    const by = (id: string) => r.findings.find((f) => f.id === id);
    expect(by('meta.camera')?.title).toBe('Camera: Canon EOS REBEL T3');
    expect(by('meta.edited')?.title).toBe('Edited with Adobe Lightroom');
    expect(by('meta.modified-later')?.title).toMatch(/11 years after capture/);
    expect(by('forensics.thumb-match')).toBeTruthy();
    expect(r.assessment.verdict).toBe('no-red-flags'); // editing alone is a notice, not an accusation
  });

  it('detects Photoshop edits', async () => {
    const r = await inspect('no_manifest.jpg', fixtureBytes('no_manifest.jpg'));
    expect(ids(r)).toEqual(expect.arrayContaining(['meta.edited', 'jpeg.photoshop']));
  });

  it('reads Stable Diffusion parameters from PNG text chunks', async () => {
    const chunk = (type: string, data: Uint8Array) => {
      const out = new Uint8Array(12 + data.length);
      new DataView(out.buffer).setUint32(0, data.length);
      out.set(latin1Bytes(type), 4);
      out.set(data, 8);
      return out;
    };
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...chunk('tEXt', latin1Bytes('parameters\0a photo of a politician shaking hands, Steps: 30, Sampler: DPM++')),
      ...chunk('IEND', new Uint8Array()),
    ]);
    expect(pngTextChunks(png)['parameters']).toMatch(/^a photo of/);
    const r = await inspect('news.png', png);
    expect(r.assessment.verdict).toBe('ai-generated');
  });
});

describe('error level analysis', () => {
  // A smooth "photo" with some sensor noise
  function photo(w: number, h: number, seed: number): Raster {
    const data = new Uint8ClampedArray(w * h * 4);
    let s = seed;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const v = 80 + 60 * Math.sin(x / 9 + seed) * Math.cos(y / 11) + (s % 20);
      const i = (y * w + x) * 4;
      data[i] = v; data[i + 1] = v * 0.8; data[i + 2] = v * 0.6; data[i + 3] = 255;
    }
    return { width: w, height: h, data };
  }

  it('locates a region pasted in from another JPEG', () => {
    // background: a photo saved a few times at q90
    let bg = photo(256, 256, 1);
    for (let i = 0; i < 3; i++) bg = decodeJpeg(encodeJpeg(bg, 90));
    // patch: cut from a different, low-quality JPEG and pasted off the 8x8 grid at (131,67)
    const patch = decodeJpeg(encodeJpeg(photo(64, 64, 99), 60));
    const data = Uint8ClampedArray.from(bg.data);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      for (let c = 0; c < 4; c++) data[((67 + y) * 256 + 131 + x) * 4 + c] = patch.data[(y * 64 + x) * 4 + c]!;
    }
    const forged = decodeJpeg(encodeJpeg({ width: 256, height: 256, data }, 95));
    const h = errorLevelAnalysis(forged).hotspot;
    expect(h).not.toBeNull();
    expect(h!.x).toBeGreaterThanOrEqual(112); expect(h!.x + h!.w).toBeLessThanOrEqual(208);
    expect(h!.y).toBeGreaterThanOrEqual(48); expect(h!.y + h!.h).toBeLessThanOrEqual(144);
    expect(h!.meanRatio).toBeGreaterThan(2.5);
  });

  it('a uniformly compressed image has no hotspot', () => {
    let img = photo(256, 256, 7);
    for (let i = 0; i < 3; i++) img = decodeJpeg(encodeJpeg(img, 90));
    const h = errorLevelAnalysis(decodeJpeg(encodeJpeg(img, 95))).hotspot;
    expect(!h || h.share < 0.002 || h.meanRatio < 2.5).toBe(true);
  });
});

describe('perceptual hash', () => {
  it('survives re-compression but not content changes', () => {
    const img = decodeJpeg(fixtureBytes('IMG_0003.jpg'));
    const again = decodeJpeg(encodeJpeg(img, 60));
    expect(hammingHex(dHash(img), dHash(again))).toBeLessThanOrEqual(4);
    expect(hammingHex(dHash(img), dHash(decodeJpeg(fixtureBytes('no_manifest.jpg'))))).toBeGreaterThan(18);
  });
});

describe('content credentials (C2PA)', () => {
  it('valid signature from a test certificate: intact, but origin unconfirmed', () => {
    const f = provenanceFindings(fixtureJson('c2pa/valid-untrusted.json'));
    expect(f[0]).toMatchObject({ id: 'c2pa.valid-untrusted', polarity: 'neutral', title: 'Valid signature from an unverified signer (C2PA Signer)' });
    expect(f.map((x) => x.id)).toContain('c2pa.algorithmic');
    expect(f.find((x) => x.id === 'c2pa.history')?.title).toBe('Recorded history: created (Make Test Images 0.33.1)');
  });

  it('pixels changed after signing', () => {
    const f = provenanceFindings(fixtureJson('c2pa/data-tampered.json'));
    expect(f[0]).toMatchObject({ id: 'c2pa.invalid', severity: 'critical' });
    expect(f[0]!.detail).toMatch(/image data was changed after it was signed/);
  });

  it('credentials themselves altered', () => {
    expect(provenanceFindings(fixtureJson('c2pa/signature-mismatch.json'))[0]!.detail).toMatch(/signature does not match/);
  });

  it('declared AI generation sets the verdict', async () => {
    const store = fixtureJson('c2pa/valid-untrusted.json');
    const m = store.manifests[store.active_manifest];
    m.assertions[1].data.actions[0].digitalSourceType = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
    const bytes = fixtureBytes('C.jpg');
    const r = await inspect('C.jpg', bytes, 'image/jpeg', new RecordedProvenance(new Map([[bytes.length, store]])));
    expect(r.assessment.verdict).toBe('ai-generated');
  });

  it('trusted credentials and no contradicting evidence verify the origin', async () => {
    const store = { ...fixtureJson('c2pa/valid-untrusted.json'), validation_state: 'Trusted', validation_results: { activeManifest: { failure: [] } } };
    const bytes = fixtureBytes('C.jpg');
    const r = await inspect('C.jpg', bytes, 'image/jpeg', new RecordedProvenance(new Map([[bytes.length, store]])));
    expect(r.findings.find((f) => f.id === 'c2pa.trusted')).toBeTruthy();
  });

  it('files without credentials just get an informational note', () => {
    expect(provenanceFindings(null)).toMatchObject([{ id: 'c2pa.none', severity: 'info' }]);
  });
});
