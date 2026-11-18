import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The dependency rule as an executable check.
const SRC = resolve(import.meta.dirname, '../src');
const files = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(p) ? [p] : [];
});
const imports = (f: string) => [...readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
const layer = (from: string, spec: string) => spec.startsWith('.') ? relative(SRC, resolve(dirname(from), spec)).split(/[\\/]/)[0]! : `pkg:${spec}`;

const RULES: Record<string, (l: string) => boolean> = {
  core: (l) => l === 'core',
  analyzers: (l) => ['core', 'analyzers', 'pkg:exifr', 'pkg:jpeg-js', 'pkg:fflate'].includes(l),
  adapters: (l) => ['core', 'analyzers', 'adapters'].includes(l) || l.startsWith('pkg:@contentauth/'),
};

describe('architecture', () => {
  for (const [name, ok] of Object.entries(RULES)) {
    it(`${name}/ respects the dependency rule`, () => {
      const bad = files(join(SRC, name)).flatMap((f) => imports(f).filter((s) => !ok(layer(f, s))).map((s) => `${relative(SRC, f)} -> ${s}`));
      expect(bad).toEqual([]);
    });
  }
});
