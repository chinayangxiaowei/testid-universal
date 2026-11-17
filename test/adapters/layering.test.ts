/**
 * Layering guard: adapters are a low layer and may depend on `src/core` only.
 * Client (`src/client`) and server (`src/server`) sit ABOVE adapters, so no adapter
 * may import from them — not even type-only (`import type`, `export ... from`, or an
 * inline `import('...')` type query).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ADAPTERS_DIR = join(__dirname, '..', '..', 'src', 'adapters');
const FORBIDDEN = /^\.\.\/(server|client)(\/|$)/;

/** Every module specifier in the file: static import/export-from, and import('...'). */
function specifiers(code: string): string[] {
  const out: string[] = [];
  const fromRe = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const bareImportRe = /\bimport\s*['"]([^'"]+)['"]/g;
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, bareImportRe, dynRe]) {
    for (const m of code.matchAll(re)) out.push(m[1]);
  }
  return out;
}

describe('adapter layering', () => {
  it('specifier scanner sees every import form', () => {
    const code = [
      "import { A } from '../server/service';",
      "import type { B } from '../client/deps';",
      "export { C } from '../server/x';",
      "export * from '../client/y';",
      "type D = import('../server/z').D;",
      "import '../client/side-effect';",
    ].join('\n');
    expect(specifiers(code).filter((s) => FORBIDDEN.test(s))).toHaveLength(6);
  });

  it('no adapter imports from ../server or ../client', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(ADAPTERS_DIR).filter((n) => n.endsWith('.ts')).sort()) {
      const code = readFileSync(join(ADAPTERS_DIR, f), 'utf8');
      for (const s of specifiers(code)) if (FORBIDDEN.test(s)) offenders.push(`${f} -> ${s}`);
    }
    expect(offenders).toEqual([]);
  });
});
