// Policy that turns individual findings into an overall, explainable assessment.
// Deliberately conservative: no tool can prove a file "true". We only say how much
// evidence points in which direction, and never hide the findings behind a single score.

import { SEVERITY_RANK, type Finding } from './findings.js';

export type Verdict =
  | 'dangerous'             // opening the file may run code or it is disguised
  | 'ai-generated'          // metadata or content credentials declare synthetic media
  | 'manipulation-likely'   // strong evidence of manipulation or tampered credentials
  | 'needs-review'          // indicators that a human should look at
  | 'verified-provenance'   // valid content credentials and no contradicting evidence
  | 'no-red-flags';         // nothing suspicious found (which is not proof of authenticity)

export interface Assessment {
  readonly verdict: Verdict;
  readonly headline: string;
  readonly explanation: string;
  /** The findings that decided the verdict, most severe first. */
  readonly keyFindings: readonly Finding[];
  readonly counts: Readonly<Record<'critical' | 'warning' | 'notice' | 'info', number>>;
  /** Things the analysis could not check, so the reader knows the limits. */
  readonly limitations: readonly string[];
}

const HEADLINES: Record<Verdict, string> = {
  dangerous: 'Do not open this file',
  'ai-generated': 'Declared as AI-generated',
  'manipulation-likely': 'Strong signs of manipulation',
  'needs-review': 'Some indicators need a closer look',
  'verified-provenance': 'Origin verified by content credentials',
  'no-red-flags': 'No red flags found',
};

export function assess(findings: readonly Finding[], limitations: readonly string[] = []): Assessment {
  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    notice: findings.filter((f) => f.severity === 'notice').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
  const critical = sorted.filter((f) => f.severity === 'critical');
  const securityCritical = critical.filter((f) => f.category === 'file-type' || f.category === 'active-content');
  const warnings = sorted.filter((f) => f.severity === 'warning' && f.polarity === 'weakens');
  const verifiedProvenance = findings.some((f) => f.category === 'provenance' && f.polarity === 'supports' && f.severity !== 'info');

  let verdict: Verdict;
  let explanation: string;
  let key: Finding[];

  if (securityCritical.length) {
    verdict = 'dangerous';
    key = securityCritical;
    explanation = 'The file is disguised or contains content that can execute when opened. Treat it as a possible attack.';
  } else if (sorted.some((f) => f.tags?.includes('ai-generated'))) {
    verdict = 'ai-generated';
    key = sorted.filter((f) => f.tags?.includes('ai-generated'));
    explanation = 'The file itself states that it was created or substantially changed by a generative AI model. It does not show a real scene as captured by a camera.';
  } else if (critical.length) {
    verdict = 'manipulation-likely';
    key = critical;
    explanation = 'At least one strong indicator contradicts what the file claims to be or shows that it was altered.';
  } else if (warnings.length) {
    verdict = 'needs-review';
    key = warnings.slice(0, 4);
    explanation = 'Indicators of editing or inconsistencies were found. They can have innocent explanations; check the details and, if possible, the original source.';
  } else if (verifiedProvenance) {
    verdict = 'verified-provenance';
    key = sorted.filter((f) => f.category === 'provenance' && f.polarity === 'supports');
    explanation = 'A cryptographically valid content credential describes where the file comes from and how it was edited, and nothing contradicts it.';
  } else {
    verdict = 'no-red-flags';
    key = [];
    explanation = 'None of the checks found suspicious signs. This does not prove the content is authentic: skilled manipulation and re-encoded files can leave no traces.';
  }

  return { verdict, headline: HEADLINES[verdict], explanation, keyFindings: key, counts, limitations };
}
