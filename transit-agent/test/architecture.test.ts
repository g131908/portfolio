import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

// Fitness functions: the dependency rule is enforced by a test, not just a diagram.
const SRC = resolve(import.meta.dirname, '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

function imports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
}

/** Layer of an import target: 'core', 'infrastructure', … or 'pkg:<name>' for npm packages. */
function layerOf(fromFile: string, spec: string): string {
  if (!spec.startsWith('.')) return `pkg:${spec}`;
  const target = relative(SRC, resolve(dirname(fromFile), spec));
  return target.split(/[\\/]/)[0]!.replace(/\.js$/, '');
}

const RULES: Record<string, (layer: string) => boolean> = {
  // business rules depend on nothing but themselves
  core: (l) => l === 'core',
  // adapters may use the core and their libraries, never delivery mechanisms
  // (llm/ implements the agent's ChatModel port, so agent/ is allowed as well)
  infrastructure: (l) => l === 'core' || l === 'agent' || l === 'infrastructure' || l === 'pkg:zod',
  // the agent knows use cases, not HTTP clients or the VBB API
  agent: (l) => l === 'core' || l === 'agent' || l === 'pkg:zod',
};

describe('architecture', () => {
  for (const [layer, allowed] of Object.entries(RULES)) {
    it(`${layer}/ only depends on what it is allowed to`, () => {
      const violations = files(join(SRC, layer)).flatMap((f) =>
        imports(f).filter((spec) => !allowed(layerOf(f, spec))).map((spec) => `${relative(SRC, f)} -> ${spec}`));
      expect(violations).toEqual([]);
    });
  }
});
