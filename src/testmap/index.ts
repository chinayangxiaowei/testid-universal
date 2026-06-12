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

/**
 * Heuristic: element types a test is likely to target (the "test-worthy" surface).
 * Substrings cover component-library naming (v-btn, el-switch, q-toggle, …);
 * `tab` is guarded against `table`. Name-matching is the WEAKEST criterion —
 * code wiring (handlers, form bindings) is checked first in isInteractive.
 */
const INTERACTIVE_TYPE =
  /(input|button|btn|select|textarea|form|link|checkbox|radio|switch|toggle|slider|picker|dropdown|menu|search|field|option|tab(?!le))/i;

/** Explicit ARIA interactive roles (per WAI-ARIA / the Cypress UI Coverage definition). */
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'radio', 'tab', 'textbox', 'link', 'menuitem', 'combobox',
  'listbox', 'option', 'searchbox', 'slider', 'spinbutton', 'switch',
]);

/**
 * Interactive = code wiring (handlers / form binding) OR tag semantics OR an
 * explicit ARIA interactive role OR tabindex >= 0. Wiring is checked first:
 * an element with a click handler is test-worthy no matter what it is called.
 */
function isInteractive(e: RegistryEntry): boolean {
  if (Object.keys(e.signals?.event_handlers ?? {}).length > 0) return true;
  if (e.signals?.form_control) return true;
  if (INTERACTIVE_TYPE.test(e.element_type)) return true;
  const role = e.signals?.role;
  if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
  const tabindex = e.signals?.static_attributes?.tabindex;
  return tabindex != null && Number(tabindex) >= 0;
}

export interface UncoveredId { id: string; element_type: string; interactive: boolean }
export interface RuntimeCoverage {
  /** Registry ids that were actually looked up at run time. */
  exercised: number;
  /** Referenced by some test, yet never looked up in the recorded runs. */
  referencedNotExercised: string[];
  /** Ids exercised at run time that are NOT in the registry (dynamic bound ids). */
  unknownExercised: string[];
}

export interface CoverageReport {
  total: number;
  covered: number;
  ratio: number;
  interactive: { total: number; covered: number; ratio: number };
  uncovered: UncoveredId[];
  /** Present when an exercised-ids artifact was supplied. */
  runtime?: RuntimeCoverage;
}

/**
 * Test coverage over the registry: which tagged ids are referenced by at least one
 * test. "All diffs green" only proves consistency of what tests already reference;
 * this report answers the adequacy question — and `uncovered` is the work list.
 */
export function coverageReport(snapshot: RegistrySnapshot, testMap: Record<string, string[]>, exercisedIds?: string[]): CoverageReport {
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
  let runtime: RuntimeCoverage | undefined;
  if (exercisedIds) {
    const exercised = new Set(exercisedIds);
    const registryIds = new Set(Object.keys(snapshot.entries));
    runtime = {
      exercised: [...exercised].filter((id) => registryIds.has(id)).length,
      referencedNotExercised: Object.keys(snapshot.entries)
        .filter((id) => (testMap[id]?.length ?? 0) > 0 && !exercised.has(id))
        .sort(),
      unknownExercised: [...exercised].filter((id) => !registryIds.has(id)).sort(),
    };
  }
  return {
    runtime,
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
  if (r.runtime) {
    L.push(
      `- exercised at run time: **${r.runtime.exercised}** registry ids; ` +
      `referenced-but-never-exercised: **${r.runtime.referencedNotExercised.length}**; ` +
      `dynamic ids outside the registry: **${r.runtime.unknownExercised.length}**`,
    );
    if (r.runtime.referencedNotExercised.length) {
      L.push('', '## Referenced but never exercised', ...r.runtime.referencedNotExercised.map((id) => `- \`${id}\``));
    }
    if (r.runtime.unknownExercised.length) {
      L.push('', '## Exercised dynamic ids (not in registry)', ...r.runtime.unknownExercised.map((id) => `- \`${id}\``));
    }
  }
  if (r.uncovered.length) {
    L.push('', '## Uncovered (interactive first)', '| TestID | Type |', '| --- | --- |');
    for (const u of r.uncovered) L.push(`| \`${u.id}\` | ${u.element_type}${u.interactive ? ' ⚠' : ''} |`);
  }
  return L.join('\n') + '\n';
}
