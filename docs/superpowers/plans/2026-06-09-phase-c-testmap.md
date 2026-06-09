# Phase C — testID → test-case Map (fail-closed routing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an id diff into a precise re-test action list: emit generated id constants (so a removed/renamed id breaks tests at compile time — fail-closed), scan tests to map each id to the tests that reference it, and combine diff + map into an "affected tests" report.

**Architecture:** Three pure, framework-agnostic pieces. `generateConstants` (in the locators layer) emits a `testIds` TS module reusing the existing `camelName`. A new `src/testmap/` layer scans test sources for `testIds.<name>` references and raw id strings to build `id → [test files]`, then `affectedTests` joins a `DiffResult` with that map into per-id actions (`write-new` / `retire` / `re-test`).

**Tech Stack:** TypeScript 5.x, Node 20+, Vitest 4. Run all commands from the `main/` worktree.

**Spec:** `docs/superpowers/specs/2026-06-09-sticky-testids-dual-map.md` §3.2 (Phase C). This plan implements Phase C only; the testID→source-dependency map is Phase D. CLI exposure of these functions is deferred (library + tests now).

**Conventions:** Code/comments/commit messages in English. Single test file: `npx vitest run <path>`.

---

### Task 1: Generated id constants

**Files:**
- Modify: `src/locators/index.ts` (`generateConstants` + export `constNameForId`)
- Test: `test/locators/constants.test.ts` (create)

- [ ] **Step 1: Write the failing test `test/locators/constants.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { generateConstants, constNameForId } from '../../src/locators';
import { snapshot, entry } from '../helpers';

describe('generateConstants', () => {
  it('emits a frozen testIds map of camelName -> id, sorted', () => {
    const snap = snapshot(1, {
      'login__button--login': entry({ fingerprint: 'F', identity: 'login::button::login' }),
      'login__input--email': entry({ fingerprint: 'G', identity: 'login::input::email' }),
    });
    const out = generateConstants(snap);
    expect(out).toContain("export const testIds = {");
    expect(out).toContain("loginButtonLogin: 'login__button--login',");
    expect(out).toContain("loginInputEmail: 'login__input--email',");
    expect(out).toContain('} as const;');
    // sorted: email constant appears after button constant (ids sorted)
    expect(out.indexOf('loginButtonLogin')).toBeLessThan(out.indexOf('loginInputEmail'));
  });
});

describe('constNameForId', () => {
  it('is a stable camelCase identifier derived from the id', () => {
    expect(constNameForId('login__button--login')).toBe('loginButtonLogin');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/locators/constants.test.ts`
Expected: FAIL — `generateConstants` / `constNameForId` not exported.

- [ ] **Step 3: Implement in `src/locators/index.ts`**

The file already has a private `camelName(id: string): string` and a `sortedIds(snapshot)` helper. Add these exports (place after the existing `generateLocatorsSafe` function):

```ts
/** The camelCase constant name a test would import for this id (e.g. `loginButtonLogin`). */
export function constNameForId(id: string): string {
  return camelName(id);
}

/**
 * Emit a framework-agnostic constants module. Tests import these instead of
 * hardcoding id strings, so a removed/renamed id makes the constant vanish and
 * the test fails to compile (fail-closed).
 */
export function generateConstants(snapshot: RegistrySnapshot): string {
  const lines = ['// Auto-generated testid constants. Do not edit by hand.', '', 'export const testIds = {'];
  for (const id of sortedIds(snapshot)) lines.push(`  ${camelName(id)}: '${id}',`);
  lines.push('} as const;', '');
  return lines.join('\n');
}
```

(`RegistrySnapshot` is already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/locators/constants.test.ts`
Expected: PASS (3 assertions across 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/locators/index.ts test/locators/constants.test.ts
git commit -m "Emit generated testId constants module (fail-closed anchor for tests)"
```

---

### Task 2: Scan tests to build the id → test-files map

**Files:**
- Create: `src/testmap/index.ts`
- Test: `test/testmap/buildTestMap.test.ts` (create)

- [ ] **Step 1: Write the failing test `test/testmap/buildTestMap.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildTestMap } from '../../src/testmap';
import { snapshot, entry } from '../helpers';

const snap = snapshot(1, {
  'login__button--login': entry({ fingerprint: 'F', identity: 'login::button::login' }),
  'login__input--email': entry({ fingerprint: 'G', identity: 'login::input::email' }),
});

describe('buildTestMap', () => {
  it('maps an id to a test that references its generated constant', () => {
    const map = buildTestMap([
      { file: 'a.spec.ts', source: 'await page.getByTestId(testIds.loginButtonLogin).click();' },
    ], snap);
    expect(map['login__button--login']).toEqual(['a.spec.ts']);
    expect(map['login__input--email']).toBeUndefined();
  });

  it('also matches a raw id string literal', () => {
    const map = buildTestMap([
      { file: 'b.spec.ts', source: `cy.get('[data-testid="login__input--email"]')` },
    ], snap);
    expect(map['login__input--email']).toEqual(['b.spec.ts']);
  });

  it('lists every test file that references the same id', () => {
    const map = buildTestMap([
      { file: 'a.spec.ts', source: 'testIds.loginButtonLogin' },
      { file: 'c.spec.ts', source: "'login__button--login'" },
    ], snap);
    expect(map['login__button--login'].sort()).toEqual(['a.spec.ts', 'c.spec.ts']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/testmap/buildTestMap.test.ts`
Expected: FAIL — module `../../src/testmap` not found.

- [ ] **Step 3: Implement `src/testmap/index.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/testmap/buildTestMap.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/testmap/index.ts test/testmap/buildTestMap.test.ts
git commit -m "Add testID->test-case scanner (constant + raw-id references)"
```

---

### Task 3: Combine diff + map into an affected-tests report

**Files:**
- Modify: `src/testmap/index.ts` (`affectedTests` + `affectedTestsToMarkdown`)
- Test: `test/testmap/affectedTests.test.ts` (create)

- [ ] **Step 1: Write the failing test `test/testmap/affectedTests.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { affectedTests, affectedTestsToMarkdown } from '../../src/testmap';
import { DiffResult } from '../../src/registry/diff';

const diff: DiffResult = {
  from_version: 1, to_version: 2,
  summary: { unchanged: 0, added: 1, removed: 1, modified: 1, regenerated: 0 },
  added: [{ id: 'a__new', identity: 'a::x::new', component: 'a' }],
  removed: [{ id: 'a__gone', identity: 'a::x::gone', component: 'a' }],
  modified: [{ id: 'a__changed', identity: 'a::x::changed', component: 'a', changes: [{ field: 'text', old: 'A', new: 'B' }] }],
  regenerated: [],
};

const map = { a__changed: ['spec/x.spec.ts'], a__gone: ['spec/y.spec.ts'] };

describe('affectedTests', () => {
  it('routes each diff change to its action and referencing tests', () => {
    const aff = affectedTests(diff, map);
    expect(aff.find((a) => a.id === 'a__changed')).toMatchObject({ action: 're-test', tests: ['spec/x.spec.ts'] });
    expect(aff.find((a) => a.id === 'a__gone')).toMatchObject({ action: 'retire', tests: ['spec/y.spec.ts'] });
    expect(aff.find((a) => a.id === 'a__new')).toMatchObject({ action: 'write-new', tests: [] });
  });
});

describe('affectedTestsToMarkdown', () => {
  it('renders the actions and cites the tests', () => {
    const md = affectedTestsToMarkdown(affectedTests(diff, map));
    expect(md).toContain('re-test');
    expect(md).toContain('a__changed');
    expect(md).toContain('spec/x.spec.ts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/testmap/affectedTests.test.ts`
Expected: FAIL — `affectedTests` / `affectedTestsToMarkdown` not exported.

- [ ] **Step 3: Add to `src/testmap/index.ts`**

Append (add the import for `DiffResult` at the top of the file alongside the existing imports):

```ts
import { DiffResult } from '../registry/diff';

export type RetestAction = 'write-new' | 'retire' | 're-test';
export interface AffectedTest { id: string; action: RetestAction; tests: string[] }

/** Join a diff with the test map: which tests must be written / retired / re-tested. */
export function affectedTests(diff: DiffResult, testMap: Record<string, string[]>): AffectedTest[] {
  const out: AffectedTest[] = [];
  for (const a of diff.added) out.push({ id: a.id, action: 'write-new', tests: testMap[a.id] ?? [] });
  for (const r of diff.removed) out.push({ id: r.id, action: 'retire', tests: testMap[r.id] ?? [] });
  for (const m of diff.modified) out.push({ id: m.id, action: 're-test', tests: testMap[m.id] ?? [] });
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
```

(Place the `import { DiffResult } ...` with the other imports at the top, not mid-file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/testmap/affectedTests.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/testmap/index.ts test/testmap/affectedTests.test.ts
git commit -m "Add affected-tests report joining diff with the test map"
```

---

### Task 4: Export from the library, verify, CLAUDE.md

**Files:**
- Modify: `src/index.ts` (export the new modules)
- Modify: `CLAUDE.md` (container) — note Phase C
- Test: full suite + typecheck + build

- [ ] **Step 1: Export the new surface from `src/index.ts`**

Add this line (after the existing `export * from './locators';` line):

```ts
export * from './testmap';
```

(`generateConstants` / `constNameForId` are already exported via `export * from './locators';`.)

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — all test files green (existing + constants + buildTestMap + affectedTests).

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 4: Update `CLAUDE.md` (container file, outside the worktree)**

Under the identity-model / phases area, add: Phase C implemented — `generateConstants` emits a `testIds` module (tests import it → removed/renamed id fails closed at compile time); `buildTestMap` scans test sources (constant refs + raw id strings) into `id → [test files]`; `affectedTests(diff, map)` produces the re-test action list (`write-new` / `retire` / `re-test`). Note these are library functions; CLI exposure is deferred. Phase D (source-dependency map) remains.

- [ ] **Step 5: Commit any tracked changes**

```bash
git add src/index.ts
git commit -m "Phase C complete: export testmap; constants + map + affected-tests verified"
```

(`CLAUDE.md` is untracked and outside the worktree; if it is the only change, note it rather than commit.)

---

## Self-review

- **Spec coverage (§3.2):** generated constants + fail-closed → Task 1 (constants module; fail-closed is the import-and-compile usage, documented); test-map scanner (constant refs + raw id fallback) → Task 2; "route id changes to specific tests" → Task 3 (`affectedTests`). Exported → Task 4.
- **Placeholder scan:** none — every code step shows complete code; commands have expected outcomes.
- **Type consistency:** `constNameForId` (Task 1, in locators) is imported by `buildTestMap` (Task 2); `buildTestMap` returns `Record<string, string[]>` consumed by `affectedTests` (Task 3) as `testMap`; `affectedTests` reads `DiffResult.added/removed/modified` whose `SimpleEntry`/`ModifyEntry` have `.id` (matches `src/registry/diff.ts`); `AffectedTest` shape is asserted in the Task 3 test and rendered by `affectedTestsToMarkdown`.
