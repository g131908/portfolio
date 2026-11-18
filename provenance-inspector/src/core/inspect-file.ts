// Use case: inspect one file with every applicable analyzer.
// Analyzers are isolated from each other: one that crashes or hangs cannot take the report down.

import { assess, type Assessment } from './assessment.js';
import { finding, type Finding } from './findings.js';

export interface FileInput {
  readonly name: string;
  /** MIME type as declared by the browser or the sender (may be empty or wrong). */
  readonly declaredType: string;
  readonly bytes: Uint8Array;
  readonly lastModified: number | null;
}

/** Facts shared by all analyzers, computed once. */
export interface FileContext extends FileInput {
  /** Detected from content, never from the name. */
  readonly detectedType: DetectedType;
}

export interface DetectedType {
  readonly id: string;          // e.g. 'jpeg', 'pdf', 'pe-executable', 'docx'
  readonly label: string;       // human readable
  readonly mime: string | null;
  readonly family: 'image' | 'document' | 'archive' | 'executable' | 'script' | 'media' | 'text' | 'unknown';
  readonly extensions: readonly string[];
}

export interface Analyzer {
  readonly id: string;
  readonly label: string;
  appliesTo(ctx: FileContext): boolean;
  analyze(ctx: FileContext): Promise<Finding[]>;
}

export interface TypeDetector {
  detect(bytes: Uint8Array): DetectedType;
}

export interface InspectionReport {
  readonly file: { name: string; size: number; declaredType: string; detectedType: DetectedType };
  readonly findings: readonly Finding[];
  readonly assessment: Assessment;
  readonly analyzers: ReadonlyArray<{ id: string; label: string; status: 'ok' | 'skipped' | 'failed' | 'timeout'; ms: number }>;
}

export interface InspectOptions {
  readonly maxBytes: number;
  readonly analyzerTimeoutMs: number;
  readonly now?: () => number;
}

const DEFAULTS: InspectOptions = { maxBytes: 100 * 1024 * 1024, analyzerTimeoutMs: 20_000 };

export class FileTooLargeError extends Error {
  override readonly name = 'FileTooLargeError';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); }),
  ]);
}

export class InspectFile {
  private readonly opts: InspectOptions;

  constructor(
    private readonly detector: TypeDetector,
    private readonly analyzers: readonly Analyzer[],
    opts: Partial<InspectOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  async execute(input: FileInput): Promise<InspectionReport> {
    if (input.bytes.length > this.opts.maxBytes) {
      throw new FileTooLargeError(`File is larger than ${Math.round(this.opts.maxBytes / 1048576)} MB`);
    }
    const now = this.opts.now ?? (() => performance.now());
    const ctx: FileContext = { ...input, detectedType: this.detector.detect(input.bytes) };

    const runs = await Promise.all(this.analyzers.map(async (a) => {
      if (!a.appliesTo(ctx)) return { a, status: 'skipped' as const, ms: 0, findings: [] as Finding[] };
      const started = now();
      try {
        const res = await withTimeout(a.analyze(ctx), this.opts.analyzerTimeoutMs);
        const ms = Math.round(now() - started);
        if (res === 'timeout') {
          return { a, status: 'timeout' as const, ms, findings: [] };
        }
        return { a, status: 'ok' as const, ms, findings: res };
      } catch (err) {
        return {
          a, status: 'failed' as const, ms: Math.round(now() - started),
          findings: [finding(a.id, {
            id: `${a.id}.failed`, category: 'structure', severity: 'notice', polarity: 'neutral',
            title: `${a.label} could not finish`,
            detail: `The file could not be fully parsed by this check (${(err as Error).message}). Malformed files are sometimes crafted on purpose.`,
          })],
        };
      }
    }));

    const findings = runs.flatMap((r) => r.findings);
    const limitations = runs
      .filter((r) => r.status === 'timeout' || r.status === 'failed')
      .map((r) => `${r.a.label} ${r.status === 'timeout' ? 'timed out' : 'failed'}; its evidence is missing.`);

    return {
      file: { name: input.name, size: input.bytes.length, declaredType: input.declaredType, detectedType: ctx.detectedType },
      findings,
      assessment: assess(findings, limitations),
      analyzers: runs.map((r) => ({ id: r.a.id, label: r.a.label, status: r.status, ms: r.ms })),
    };
  }
}

/**
 * Adds findings from checks that ran elsewhere (e.g. the C2PA SDK on another thread)
 * and re-runs the assessment over the complete evidence.
 */
export function extendReport(
  report: InspectionReport,
  extra: { findings: readonly Finding[]; analyzer: { id: string; label: string; status: 'ok' | 'skipped' | 'failed' | 'timeout'; ms: number } },
): InspectionReport {
  const findings = [...report.findings, ...extra.findings];
  const limitations = [...report.assessment.limitations];
  if (extra.analyzer.status === 'failed' || extra.analyzer.status === 'timeout') {
    limitations.push(`${extra.analyzer.label} ${extra.analyzer.status === 'timeout' ? 'timed out' : 'failed'}; its evidence is missing.`);
  }
  return { ...report, findings, analyzers: [...report.analyzers, extra.analyzer], assessment: assess(findings, limitations) };
}
