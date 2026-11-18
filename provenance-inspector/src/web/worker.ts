// Runs the CPU-heavy checks off the UI thread so the page stays responsive.
import { defaultAnalyzers, MagicByteDetector } from '../analyzers/index.js';
import { compareImages } from '../analyzers/compare.js';
import { cachedEla } from '../analyzers/forensics.js';
import { decodeJpeg, resize, type Raster } from '../analyzers/image-math.js';
import { decodeWithBrowser } from '../adapters/browser-raster.js';
import { InspectFile } from '../core/inspect-file.js';
import type { FromWorker, Heatmap, ToWorker } from './protocol.js';

const inspector = new InspectFile(new MagicByteDetector(), defaultAnalyzers(null), { analyzerTimeoutMs: 30_000 });
const MAX_HEATMAP_SIDE = 1600;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function shrink(r: Raster): Raster {
  const scale = Math.min(1, MAX_HEATMAP_SIDE / Math.max(r.width, r.height));
  return scale < 1 ? resize(r, Math.round(r.width * scale), Math.round(r.height * scale)) : r;
}

async function decodeAny(bytes: Uint8Array, type: string): Promise<Raster> {
  try {
    return await decodeWithBrowser(bytes, type);
  } catch {
    return decodeJpeg(bytes); // e.g. browsers without OffscreenCanvas in workers
  }
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    if (msg.kind === 'inspect') {
      const bytes = new Uint8Array(msg.file.buffer);
      const report = await inspector.execute({ name: msg.file.name, declaredType: msg.file.type, bytes, lastModified: msg.file.lastModified });
      let ela: Heatmap | null = null;
      if (report.file.detectedType.id === 'jpeg' && report.analyzers.find((a) => a.id === 'forensics')?.status === 'ok') {
        try {
          const r = cachedEla(bytes); // computed by the forensics analyzer moments ago
          const small = shrink({ width: r.width, height: r.height, data: r.heatmap });
          const k = small.width / r.width;
          const h = r.hotspot;
          ela = {
            width: small.width, height: small.height, buffer: Uint8ClampedArray.from(small.data).buffer,
            hotspot: h ? { x: h.x * k, y: h.y * k, w: h.w * k, h: h.h * k } : null,
          };
        } catch { /* no heatmap available */ }
      }
      post({ kind: 'report', id: msg.id, report, ela }, ela ? [ela.buffer] : []);
    } else {
      const a = new Uint8Array(msg.a.buffer);
      const b = new Uint8Array(msg.b.buffer);
      const [ra, rb] = await Promise.all([decodeAny(a, msg.a.type), decodeAny(b, msg.b.type)]);
      const { diff, ...comparison } = await compareImages(a, ra, b, rb);
      const buffer = diff.rgba.buffer as ArrayBuffer;
      post({ kind: 'comparison', id: msg.id, comparison, diff: { width: diff.width, height: diff.height, buffer, hotspot: null } }, [buffer]);
    }
  } catch (err) {
    post({ kind: 'error', id: msg.id, message: (err as Error).message || String(err) });
  }
};
