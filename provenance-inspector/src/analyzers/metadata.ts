// Image metadata (EXIF, XMP, IPTC and PNG text chunks): capture device, editing software,
// editing history, dates, location, and markers left by AI image generators.

import exifr from 'exifr';
import type { Analyzer, FileContext } from '../core/inspect-file.js';
import { finding, type Finding } from '../core/findings.js';
import { u32be } from './bytes.js';

const A = 'metadata';

const EDITORS: Array<[RegExp, string]> = [
  [/photoshop/i, 'Adobe Photoshop'], [/lightroom/i, 'Adobe Lightroom'], [/gimp/i, 'GIMP'],
  [/affinity/i, 'Affinity Photo'], [/snapseed/i, 'Snapseed'], [/facetune/i, 'Facetune'],
  [/picsart/i, 'PicsArt'], [/canva/i, 'Canva'], [/pixelmator/i, 'Pixelmator'], [/luminar/i, 'Luminar'],
  [/capture one/i, 'Capture One'], [/paint\.net/i, 'Paint.NET'], [/photopea/i, 'Photopea'],
];

const AI_TOOLS: Array<[RegExp, string]> = [
  [/midjourney/i, 'Midjourney'], [/dall[\s·.-]?e/i, 'DALL·E'], [/stable[\s-]?diffusion|sdxl/i, 'Stable Diffusion'],
  [/firefly/i, 'Adobe Firefly'], [/imagen/i, 'Google Imagen'], [/gemini/i, 'Google Gemini'],
  [/chatgpt|openai|gpt-?4o|gpt-image/i, 'OpenAI'], [/\bflux(\.1)?\b/i, 'FLUX'], [/leonardo\.ai/i, 'Leonardo.Ai'],
  [/novelai/i, 'NovelAI'], [/comfyui/i, 'ComfyUI'], [/automatic1111|a1111/i, 'Automatic1111'], [/ideogram/i, 'Ideogram'],
  [/grok|aurora/i, 'xAI'], [/runway/i, 'Runway'], [/bing image creator|designer/i, 'Microsoft Designer'],
];

/** IPTC "digital source type" values that declare synthetic media. */
const AI_SOURCE_TYPES = /trainedAlgorithmicMedia/i; // also matches compositeWithTrainedAlgorithmicMedia

type Meta = Record<string, unknown>;

function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(str).join(' ');
  if (typeof v === 'object') return Object.values(v as object).map(str).join(' ');
  return String(v);
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === 'string') {
    const d = new Date(v.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** PNG tEXt/iTXt chunks, where Stable Diffusion tools store prompts and settings. */
export function pngTextChunks(b: Uint8Array, limit = 200): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 8;
  for (let n = 0; p + 12 <= b.length && n < limit; n++) {
    const len = u32be(b, p);
    const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!);
    const data = b.subarray(p + 8, Math.min(p + 8 + len, b.length));
    if (type === 'tEXt' || type === 'iTXt') {
      const nul = data.indexOf(0);
      if (nul > 0) {
        const key = new TextDecoder('latin1').decode(data.subarray(0, nul));
        // iTXt has compression flag, method, language and translated keyword before the text
        let rest = data.subarray(nul + 1);
        if (type === 'iTXt') {
          let skip = 2;
          for (let z = 0; z < 2; z++) skip = rest.indexOf(0, skip) + 1;
          rest = rest.subarray(skip);
        }
        out[key] = new TextDecoder().decode(rest).slice(0, 2000);
      }
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

export const metadataAnalyzer: Analyzer = {
  id: A,
  label: 'Metadata check',
  appliesTo: (ctx) => ['jpeg', 'png', 'tiff', 'heic', 'webp', 'avif'].includes(ctx.detectedType.id),
  async analyze(ctx: FileContext): Promise<Finding[]> {
    const out: Finding[] = [];
    const meta: Meta = (await exifr.parse(ctx.bytes, {
      tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false,
      mergeOutput: true, translateValues: true, reviveValues: true,
    }).catch(() => null)) ?? {};
    const pngText = ctx.detectedType.id === 'png' ? pngTextChunks(ctx.bytes) : {};

    // --- AI generation markers ------------------------------------------------------
    const sourceType = str(meta['DigitalSourceType'] ?? meta['digitalsourcetype']);
    const toolText = [meta['Software'], meta['CreatorTool'], meta['Creator'], meta['Artist'], meta['ImageDescription'], meta['Credit'], pngText['Software']].map(str).join(' | ');
    const aiTool = AI_TOOLS.find(([re]) => re.test(toolText))?.[1];
    const sdParams = pngText['parameters'] ?? pngText['prompt'] ?? pngText['workflow'];
    if (AI_SOURCE_TYPES.test(sourceType) || aiTool || sdParams) {
      const reason = AI_SOURCE_TYPES.test(sourceType)
        ? `IPTC digital source type: ${sourceType.split('/').pop()}`
        : aiTool ? `generator named in metadata: ${aiTool}` : 'generation parameters (prompt) stored in the PNG';
      out.push(finding(A, {
        id: 'meta.ai-generated', category: 'metadata', severity: 'critical', polarity: 'weakens', tags: ['ai-generated'],
        title: 'Metadata says this image was made by AI',
        detail: `${reason}. The image is not a photograph of a real scene. (Absence of such markers does not prove the opposite: they are easy to remove.)`,
        data: sdParams ? { prompt: sdParams.slice(0, 300) } : { marker: reason },
      }));
    }

    // --- capture device -------------------------------------------------------------------
    const make = str(meta['Make']).trim();
    const model = str(meta['Model']).trim();
    if (make || model) {
      out.push(finding(A, {
        id: 'meta.camera', category: 'metadata', severity: 'info', polarity: 'neutral',
        title: `Camera: ${model.startsWith(make) ? model : `${make} ${model}`.trim()}`,
        detail: 'Device information written by the camera or phone.',
        data: { make: make || null, model: model || null, lens: str(meta['LensModel']) || null },
      }));
    }

    // --- editing software and history ---------------------------------------------------
    const history = Array.isArray(meta['History']) ? meta['History'] : meta['History'] ? [meta['History']] : [];
    const agents = history.map((h) => str((h as Meta)['softwareAgent'])).filter(Boolean);
    const editor = EDITORS.find(([re]) => re.test(`${toolText} ${agents.join(' ')}`))?.[1];
    if (editor) {
      out.push(finding(A, {
        id: 'meta.edited', category: 'metadata', severity: 'notice', polarity: 'weakens',
        title: `Edited with ${editor}`,
        detail: 'Editing is normal for photos (exposure, cropping). It means the file is not the camera original, so details may have been changed.',
        data: { software: str(meta['Software']) || str(meta['CreatorTool']) || null, historySteps: history.length },
      }));
    }

    // --- dates ------------------------------------------------------------------------------
    // Only the camera's own capture time counts; CreateDate is often the file creation by an editor.
    const taken = toDate(meta['DateTimeOriginal']);
    const modified = toDate(meta['ModifyDate']);
    const now = Date.now();
    if (taken) {
      out.push(finding(A, {
        id: 'meta.taken', category: 'metadata', severity: 'info', polarity: 'neutral',
        title: `Captured ${taken.toISOString().slice(0, 10)}`,
        detail: 'Capture date from the camera clock. Camera clocks can be wrong and the value is easy to edit.',
        data: { taken: taken.toISOString() },
      }));
      if (taken.getTime() > now + 86_400_000) {
        out.push(finding(A, {
          id: 'meta.future', category: 'metadata', severity: 'warning', polarity: 'weakens',
          title: 'Capture date is in the future',
          detail: 'Either the camera clock was wrong or the metadata was edited.',
        }));
      }
    }
    if (taken && modified) {
      const days = (modified.getTime() - taken.getTime()) / 86_400_000;
      if (days > 1) {
        out.push(finding(A, {
          id: 'meta.modified-later', category: 'metadata', severity: 'notice', polarity: 'weakens',
          title: `Modified ${days > 365 ? `${Math.round(days / 365)} years` : `${Math.round(days)} days`} after capture`,
          detail: `Last saved ${modified.toISOString().slice(0, 10)}. Fine for archive photos, but worth knowing if the image is presented as new.`,
        }));
      } else if (days < -1) {
        out.push(finding(A, {
          id: 'meta.dates-inconsistent', category: 'metadata', severity: 'warning', polarity: 'weakens',
          title: 'Modification date is before capture date',
          detail: 'This order is impossible without editing the metadata or a wrong clock.',
        }));
      }
    }

    // --- location ----------------------------------------------------------------------------
    const lat = meta['latitude'];
    const lon = meta['longitude'];
    if (typeof lat === 'number' && typeof lon === 'number') {
      out.push(finding(A, {
        id: 'meta.gps', category: 'metadata', severity: 'notice', polarity: 'neutral',
        title: 'Contains GPS location',
        detail: 'Useful to check where a photo was taken, and a privacy risk when sharing: anyone with the file can see the location.',
        data: { latitude: Math.round(lat * 1e4) / 1e4, longitude: Math.round(lon * 1e4) / 1e4 },
      }));
    }
    return out;
  },
};
