/**
 * testID -> test-case map. Scans test sources for references to an id — either via
 * its generated constant (`testIds.loginButtonLogin`) or a raw id string literal —
 * and returns `id -> [test files]`. Combined with a diff (see affectedTests) this
 * routes "id added/removed/changed" to the exact tests that must be revisited.
 */
import { RegistrySnapshot, RegistryEntry } from '../registry/storage';
import { constNameForId } from '../locators';
import { DiffResult } from '../registry/diff';

export function buildTestMap(
  testFiles: { file: string; source: string }[],
  snapshot: RegistrySnapshot,
): Record<string, string[]> {
  return buildTestMapForIds(testFiles, Object.keys(snapshot.entries));
}

/**
 * Id-list variant: lets callers scan for ids that are not all present in any single
 * snapshot (e.g. the union of a diff's added + removed + modified ids), and works
 * over either transport since it needs no snapshot loading.
 */
export function buildTestMapForIds(
  testFiles: { file: string; source: string }[],
  ids: string[],
): Record<string, string[]> {
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

/** Heuristic: element types a test is likely to target (the "test-worthy" surface). */
const INTERACTIVE_TYPE = /(input|button|select|textarea|form|link|checkbox)/i;

/** Explicit ARIA interactive roles (per WAI-ARIA / the Cypress UI Coverage definition). */
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'radio', 'tab', 'textbox', 'link', 'menuitem', 'combobox',
  'listbox', 'option', 'searchbox', 'slider', 'spinbutton', 'switch',
]);

/**
 * Interactive = tag semantics OR an explicit ARIA interactive role OR tabindex >= 0.
 * (A <i role="button"> or a focusable <div> is test-worthy even though its tag is not.)
 */
function isInteractive(e: RegistryEntry): boolean {
  if (INTERACTIVE_TYPE.test(e.element_type)) return true;
  const role = e.signals?.role;
  if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
  const tabindex = e.signals?.static_attributes?.tabindex;
  return tabindex != null && Number(tabindex) >= 0;
}

export interface UncoveredId { id: string; element_type: string; interactive: boolean }
export interface CoverageReport {
  total: number;
  covered: number;
  ratio: number;
  interactive: { total: number; covered: number; ratio: number };
  uncovered: UncoveredId[];
}

/**
 * Test coverage over the registry: which tagged ids are referenced by at least one
 * test. "All diffs green" only proves consistency of what tests already reference;
 * this report answers the adequacy question — and `uncovered` is the work list.
 */
export function coverageReport(snapshot: RegistrySnapshot, testMap: Record<string, string[]>): CoverageReport {
  let covered = 0;
  let iTotal = 0;
  let iCovered = 0;
  const uncovered: UncoveredId[] = [];
  const entries = Object.entries(snapshot.entries);
  for (const [id, e] of entries) {
    const isCovered = (testMap[id]?.length ?? 0) > 0;
    const interactive = isInteractive(e);
    if (interactive) { iTotal++; if (isCovered) iCovered++; }
    if (isCovered) covered++;
    else uncovered.push({ id, element_type: e.element_type, interactive });
  }
  uncovered.sort((a, b) => (a.interactive === b.interactive ? a.id.localeCompare(b.id) : a.interactive ? -1 : 1));
  return {
    total: entries.length,
    covered,
    ratio: entries.length ? covered / entries.length : 1,
    interactive: { total: iTotal, covered: iCovered, ratio: iTotal ? iCovered / iTotal : 1 },
    uncovered,
  };
}

export function coverageToMarkdown(r: CoverageReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const L = [
    '# TestID coverage',
    '',
    `- all tagged ids referenced by tests: **${r.covered}/${r.total}** (${pct(r.ratio)})`,
    `- interactive (test-worthy) ids covered: **${r.interactive.covered}/${r.interactive.total}** (${pct(r.interactive.ratio)})`,
  ];
  if (r.uncovered.length) {
    L.push('', '## Uncovered (interactive first)', '| TestID | Type |', '| --- | --- |');
    for (const u of r.uncovered) L.push(`| \`${u.id}\` | ${u.element_type}${u.interactive ? ' ⚠' : ''} |`);
  }
  return L.join('\n') + '\n';
}
