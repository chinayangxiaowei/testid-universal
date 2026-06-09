/**
 * testID -> test-case map. Scans test sources for references to an id — either via
 * its generated constant (`testIds.loginButtonLogin`) or a raw id string literal —
 * and returns `id -> [test files]`. Combined with a diff (see affectedTests) this
 * routes "id added/removed/changed" to the exact tests that must be revisited.
 */
import { RegistrySnapshot } from '../registry/storage';
import { constNameForId } from '../locators';
import { DiffResult } from '../registry/diff';

export function buildTestMap(
  testFiles: { file: string; source: string }[],
  snapshot: RegistrySnapshot,
): Record<string, string[]> {
  const ids = Object.keys(snapshot.entries);
  const map: Record<string, string[]> = {};
  for (const { file, source } of testFiles) {
    for (const id of ids) {
      const camel = constNameForId(id);
      const refsConstant = new RegExp(`testIds\\.${camel}(?![A-Za-z0-9_])`).test(source);
      const refsRaw = source.includes(`'${id}'`) || source.includes(`"${id}"`) || source.includes('`' + id + '`');
      if (refsConstant || refsRaw) (map[id] ??= []).push(file);
    }
  }
  return map;
}

export type RetestAction = 'write-new' | 'retire' | 're-test';
export interface AffectedTest { id: string; action: RetestAction; tests: string[] }

/** Join a diff with the test map: which tests must be written / retired / re-tested. */
export function affectedTests(diff: DiffResult, testMap: Record<string, string[]>): AffectedTest[] {
  const out: AffectedTest[] = [];
  for (const a of diff.added) out.push({ id: a.id, action: 'write-new', tests: testMap[a.id] ?? [] });
  for (const r of diff.removed) out.push({ id: r.id, action: 'retire', tests: testMap[r.id] ?? [] });
  for (const m of diff.modified) out.push({ id: m.id, action: 're-test', tests: testMap[m.id] ?? [] });
  for (const r of diff.regenerated) out.push({ id: r.id, action: 're-test', tests: testMap[r.id] ?? [] });
  out.sort((x, y) => x.id.localeCompare(y.id));
  return out;
}

export function affectedTestsToMarkdown(affected: AffectedTest[]): string {
  const L = ['# Affected tests', '', '| Action | TestID | Tests |', '| --- | --- | --- |'];
  for (const a of affected) {
    L.push(`| ${a.action} | \`${a.id}\` | ${a.tests.length ? a.tests.join(', ') : '_(none referencing)_'} |`);
  }
  return L.join('\n') + '\n';
}
