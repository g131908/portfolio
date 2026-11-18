import { describe, expect, it } from 'vitest';
import { MagicByteDetector } from '../../src/analyzers/file-type.js';
import { assess } from '../../src/core/assessment.js';
import { finding } from '../../src/core/findings.js';
import { FileTooLargeError, InspectFile, type Analyzer } from '../../src/core/inspect-file.js';

const input = { name: 'x.txt', declaredType: '', bytes: new TextEncoder().encode('hello'), lastModified: null };
const ok = (id: string, sev: 'info' | 'warning' = 'info'): Analyzer => ({
  id, label: id, appliesTo: () => true,
  analyze: async () => [finding(id, { id: `${id}.f`, category: 'metadata', severity: sev, polarity: sev === 'info' ? 'neutral' : 'weakens', title: id, detail: '' })],
});

describe('InspectFile', () => {
  it('isolates a crashing analyzer and reports it as a limitation', async () => {
    const broken: Analyzer = { id: 'broken', label: 'Broken check', appliesTo: () => true, analyze: async () => { throw new Error('boom'); } };
    const r = await new InspectFile(new MagicByteDetector(), [ok('a'), broken]).execute(input);
    expect(r.analyzers.map((a) => a.status)).toEqual(['ok', 'failed']);
    expect(r.findings.map((f) => f.id)).toEqual(['a.f', 'broken.failed']);
    expect(r.assessment.limitations).toEqual(['Broken check failed; its evidence is missing.']);
  });

  it('times out a hanging analyzer without blocking the report', async () => {
    const hang: Analyzer = { id: 'hang', label: 'Slow check', appliesTo: () => true, analyze: () => new Promise(() => {}) };
    const r = await new InspectFile(new MagicByteDetector(), [ok('a'), hang], { analyzerTimeoutMs: 30 }).execute(input);
    expect(r.analyzers[1]!.status).toBe('timeout');
    expect(r.assessment.limitations[0]).toMatch(/timed out/);
  });

  it('skips analyzers that do not apply', async () => {
    const pdfOnly: Analyzer = { ...ok('pdf'), appliesTo: (c) => c.detectedType.id === 'pdf' };
    const r = await new InspectFile(new MagicByteDetector(), [pdfOnly]).execute(input);
    expect(r.analyzers[0]!.status).toBe('skipped');
  });

  it('refuses oversized files', async () => {
    await expect(new InspectFile(new MagicByteDetector(), [], { maxBytes: 3 }).execute(input)).rejects.toBeInstanceOf(FileTooLargeError);
  });
});

describe('assessment policy', () => {
  const f = (severity: 'info' | 'notice' | 'warning' | 'critical', category: 'file-type' | 'metadata' | 'provenance' = 'metadata', polarity: 'supports' | 'weakens' | 'neutral' = 'weakens') =>
    finding('t', { id: `${severity}-${category}`, category, severity, polarity, title: '', detail: '' });

  it('never calls a file authentic just because nothing was found', () => {
    const a = assess([f('info', 'metadata', 'neutral')]);
    expect(a.verdict).toBe('no-red-flags');
    expect(a.explanation).toMatch(/does not prove/);
  });

  it('ranks security over manipulation over review', () => {
    expect(assess([f('warning'), f('critical', 'file-type')]).verdict).toBe('dangerous');
    expect(assess([f('warning'), f('critical', 'metadata')]).verdict).toBe('manipulation-likely');
    expect(assess([f('notice'), f('warning')]).verdict).toBe('needs-review');
    expect(assess([f('notice')]).verdict).toBe('no-red-flags');
  });

  it('valid provenance only counts when nothing contradicts it', () => {
    expect(assess([f('notice', 'provenance', 'supports')]).verdict).toBe('verified-provenance');
    expect(assess([f('notice', 'provenance', 'supports'), f('warning')]).verdict).toBe('needs-review');
  });
});
