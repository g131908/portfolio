// Content Credentials (C2PA): a signed manifest embedded in the file that records who
// made it, with which tool, and how it was edited. Supported by Adobe, Microsoft, Google,
// OpenAI, Leica, Sony, Nikon and others.
//
// The cryptographic verification is done by the official C2PA SDK (Rust compiled to
// WebAssembly) behind the ProvenanceReader port. This module only interprets the result.

import type { Analyzer, FileContext } from '../core/inspect-file.js';
import { finding, type Finding } from '../core/findings.js';

/** Subset of the manifest store JSON produced by c2pa-rs / c2pa-web that we rely on. */
export interface ManifestStore {
  active_manifest?: string;
  manifests?: Record<string, Manifest>;
  validation_state?: 'Invalid' | 'Valid' | 'Trusted' | string;
  validation_results?: { activeManifest?: { failure?: StatusEntry[]; success?: StatusEntry[]; informational?: StatusEntry[] } };
  validation_status?: StatusEntry[];
}
interface StatusEntry { code: string; explanation?: string }
interface Manifest {
  claim_generator?: string;
  claim_generator_info?: Array<{ name?: string; version?: string }>;
  title?: string;
  signature_info?: { issuer?: string; common_name?: string; time?: string };
  assertions?: Array<{ label: string; data?: unknown }>;
  ingredients?: Array<{ title?: string; relationship?: string }>;
}

export interface ProvenanceReader {
  /** Returns null when the file carries no content credentials. */
  read(bytes: Uint8Array, mime: string): Promise<ManifestStore | null>;
}

const A = 'provenance';
const SUPPORTED = new Set(['jpeg', 'png', 'webp', 'heic', 'avif', 'tiff', 'gif', 'mp4', 'wav', 'mp3', 'pdf', 'svg']);

// Validation codes that are not failures of the content itself.
const NOT_TAMPERING = /^signingCredential\.(untrusted|ocsp)/;

const EXPLAIN: Array<[RegExp, string]> = [
  [/dataHash\.mismatch|bmffHash\.mismatch|boxesHash\.mismatch/, 'The image data was changed after it was signed.'],
  [/claimSignature\.mismatch/, 'The signature does not match the claim: the credentials themselves were altered.'],
  [/assertion\.hashedURI\.mismatch/, 'A recorded statement inside the credentials was altered.'],
  [/signingCredential\.(revoked|expired|invalid)/, 'The signing certificate is revoked, expired or invalid.'],
  [/ingredient/, 'A source file referenced by the credentials failed validation.'],
];

const AI_SOURCE = /trainedAlgorithmicMedia/i; // includes compositeWithTrainedAlgorithmicMedia

const ACTION_LABELS: Record<string, string> = {
  'c2pa.created': 'created', 'c2pa.opened': 'opened', 'c2pa.edited': 'edited', 'c2pa.placed': 'placed content',
  'c2pa.cropped': 'cropped', 'c2pa.resized': 'resized', 'c2pa.color_adjustments': 'colour adjusted',
  'c2pa.filtered': 'filtered', 'c2pa.drawing': 'drawn on', 'c2pa.converted': 'converted', 'c2pa.transcoded': 'transcoded',
  'c2pa.removed': 'removed content', 'c2pa.repackaged': 'repackaged', 'c2pa.published': 'published',
};

interface Action { action?: string; softwareAgent?: string | { name?: string }; digitalSourceType?: string }

function actionsOf(m: Manifest): Action[] {
  return (m.assertions ?? [])
    .filter((a) => a.label.startsWith('c2pa.actions'))
    .flatMap((a) => ((a.data as { actions?: Action[] } | undefined)?.actions ?? []));
}

function agentName(a: Action): string | null {
  if (!a.softwareAgent) return null;
  return typeof a.softwareAgent === 'string' ? a.softwareAgent : a.softwareAgent.name ?? null;
}

export function provenanceFindings(store: ManifestStore | null): Finding[] {
  if (!store?.active_manifest || !store.manifests?.[store.active_manifest]) {
    return [finding(A, {
      id: 'c2pa.none', category: 'provenance', severity: 'info', polarity: 'neutral',
      title: 'No content credentials',
      detail: 'Most files do not carry C2PA credentials yet, so their absence says nothing on its own. Credentials are also removed by most social networks and messengers.',
    })];
  }
  const out: Finding[] = [];
  const m = store.manifests[store.active_manifest]!;
  const statuses = store.validation_results?.activeManifest?.failure ?? store.validation_status ?? [];
  const failures = statuses.filter((s) => !NOT_TAMPERING.test(s.code));
  const trusted = store.validation_state === 'Trusted';
  const signer = m.signature_info?.common_name ?? m.signature_info?.issuer ?? 'unknown signer';
  const tool = m.claim_generator_info?.[0]?.name ?? m.claim_generator ?? 'unknown tool';

  if (failures.length || store.validation_state === 'Invalid') {
    const reasons = failures.map((f) => EXPLAIN.find(([re]) => re.test(f.code))?.[1] ?? f.explanation ?? f.code);
    out.push(finding(A, {
      id: 'c2pa.invalid', category: 'provenance', severity: 'critical', polarity: 'weakens',
      title: 'Content credentials are broken',
      detail: `The file carries signed credentials, but they do not verify. ${[...new Set(reasons)].join(' ')} Someone changed the file or its history after signing.`,
      data: { codes: failures.map((f) => f.code).join(', ') || store.validation_state || 'Invalid' },
    }));
  } else if (trusted) {
    out.push(finding(A, {
      id: 'c2pa.trusted', category: 'provenance', severity: 'notice', polarity: 'supports',
      title: `Verified content credentials from ${signer}`,
      detail: 'The signature is valid, the file has not changed since signing, and the signer\'s certificate chains to the C2PA trust list.',
      data: { signer, issuer: m.signature_info?.issuer ?? null, signedAt: m.signature_info?.time ?? null, tool },
    }));
  } else {
    out.push(finding(A, {
      id: 'c2pa.valid-untrusted', category: 'provenance', severity: 'notice', polarity: 'neutral',
      title: `Valid signature from an unverified signer (${signer})`,
      detail: 'The credentials are intact and the file has not changed since signing. However, the signing certificate is not on the trust list, so anyone could have created it: treat the claimed origin as unconfirmed.',
      data: { signer, issuer: m.signature_info?.issuer ?? null, signedAt: m.signature_info?.time ?? null, tool },
    }));
  }

  const actions = actionsOf(m);
  const ai = actions.find((a) => AI_SOURCE.test(a.digitalSourceType ?? ''));
  if (ai) {
    out.push(finding(A, {
      id: 'c2pa.ai-generated', category: 'provenance', severity: 'critical', polarity: 'weakens', tags: ['ai-generated'],
      title: /composite/i.test(ai.digitalSourceType ?? '') ? 'Credentials declare AI-generated parts' : 'Credentials declare the image as AI-generated',
      detail: `Recorded by ${agentName(ai) ?? tool}: digital source type "${ai.digitalSourceType?.split('/').pop()}".`,
    }));
  } else if (actions.some((a) => /\/algorithmicMedia$/i.test(a.digitalSourceType ?? ''))) {
    out.push(finding(A, {
      id: 'c2pa.algorithmic', category: 'provenance', severity: 'notice', polarity: 'neutral',
      title: 'Credentials declare computer-generated content',
      detail: 'The image was produced by an algorithm (not a camera, and not a trained AI model), e.g. a rendering or a generated graphic.',
    }));
  }

  if (actions.length) {
    const steps = actions.map((a) => `${ACTION_LABELS[a.action ?? ''] ?? a.action?.replace(/^c2pa\./, '') ?? '?'}${agentName(a) ? ` (${agentName(a)})` : ''}`);
    out.push(finding(A, {
      id: 'c2pa.history', category: 'provenance', severity: 'info', polarity: 'neutral',
      title: `Recorded history: ${steps.slice(0, 4).join(' → ')}${steps.length > 4 ? ' …' : ''}`,
      detail: 'Editing steps declared by the tools that handled the file.',
      data: { steps: steps.length, ingredients: m.ingredients?.length ?? 0 },
    }));
  }
  return out;
}

export function createProvenanceAnalyzer(reader: ProvenanceReader): Analyzer {
  return {
    id: A,
    label: 'Content credentials (C2PA)',
    appliesTo: (ctx: FileContext) => SUPPORTED.has(ctx.detectedType.id),
    async analyze(ctx: FileContext): Promise<Finding[]> {
      return provenanceFindings(await reader.read(ctx.bytes, ctx.detectedType.mime ?? ctx.declaredType));
    },
  };
}
