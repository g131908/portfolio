// What an analyzer can say about a file. Findings are evidence, not verdicts:
// each one states what was observed, how much it matters and why.

export type Category =
  | 'file-type'      // is the file what it claims to be?
  | 'active-content' // macros, scripts, auto-actions: can opening it run code?
  | 'structure'      // container anomalies: appended data, incremental edits
  | 'metadata'       // EXIF/XMP/PDF info: capture device, software, dates
  | 'provenance'     // signed content credentials (C2PA)
  | 'forensics'      // signal-level analysis such as error levels and compression
  | 'integrity';     // hashes, comparison with an original

/**
 * info     neutral fact (camera model, file hash)
 * notice   worth knowing, common in legitimate files (edited in Lightroom, metadata stripped)
 * warning  indicator of manipulation or risk that deserves a closer look
 * critical strong evidence of deception or danger (disguised executable, broken signature)
 */
export type Severity = 'info' | 'notice' | 'warning' | 'critical';

/** Direction of the evidence: does it support or weaken trust in the file? */
export type Polarity = 'supports' | 'weakens' | 'neutral';

export interface Finding {
  readonly id: string;
  readonly analyzer: string;
  readonly category: Category;
  readonly severity: Severity;
  readonly polarity: Polarity;
  readonly title: string;
  readonly detail: string;
  /** Machine-readable labels the assessment policy can react to, e.g. 'ai-generated'. */
  readonly tags?: readonly string[];
  /** Raw values behind the finding, shown in the report for transparency. */
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, notice: 1, warning: 2, critical: 3 };

export function finding(analyzer: string, f: Omit<Finding, 'analyzer'>): Finding {
  return { analyzer, ...f };
}
