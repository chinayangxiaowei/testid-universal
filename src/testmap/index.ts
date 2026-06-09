/**
 * testID -> test-case map. Scans test sources for references to an id — either via
 * its generated constant (`testIds.loginButtonLogin`) or a raw id string literal —
 * and returns `id -> [test files]`. Combined with a diff (see affectedTests) this
 * routes "id added/removed/changed" to the exact tests that must be revisited.
 */
import { RegistrySnapshot } from '../registry/storage';
import { constNameForId } from '../locators';

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
