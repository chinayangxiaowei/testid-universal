# Phase D — testID → Source-Dependency Map (Vue-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flag linked tests for re-test even when an id did not change, by tracking the *definitions* of the symbols an element references (handler bodies, bound identifiers, v-model targets) and surfacing definition changes in the diff.

**Architecture:** Split per the project rule (vocabulary=adapter, policy=core). The adapter contract gains an optional `resolveSymbolDefs(names, source, file)` returning **raw definition source text** (Vue implements it with `compileScript`'s `bindings` + `scriptSetupAst` — zero new deps, verified in `docs/findings/2026-06-10-phase-d-reference-survey.md`). Core owns: which names to resolve (`referencedSymbolNames`), normalization+hashing (`hashSymbolSources` — adapters can never fabricate hashes), draft/registry storage (`symbol_defs`), and diff semantics (a symbol-hash change makes the entry `modified` with `symbol:<name>` changes even when the fingerprint is identical). The pipeline orchestrates per-file resolution; nodes carry `symbol_sources`, so both transports get the capability for free.

**Tech Stack:** TypeScript 5.x, Node 20+, Vitest 4, `@vue/compiler-sfc` (existing optional peer dep). Run all commands from the worktree root.

**Spec:** `docs/superpowers/specs/2026-06-09-sticky-testids-dual-map.md` §3.3–§3.5 (Phase D). Scope = increment 1 only: Vue `<script setup>` local definitions; imported names hash their import statement (L3 opaque boundary); options-API / plain `<script>` / Angular / React degrade to no `symbol_defs` (current behavior). Resolved open question (spec §6): definition-hash normalization is **whitespace-collapse only, comments NOT stripped** — comment edits over-flag re-test (safe direction); naive comment stripping risks corrupting string literals and under-flagging.

**Conventions:** Code/comments/commit messages in English. Single test file: `npx vitest run <path>`.

---

### Task 1: Core source-deps module (name policy + hashing) and types

**Files:**
- Modify: `src/core/types.ts` (`ElementNode.symbol_sources`, `EntryDraft.symbol_defs`)
- Create: `src/core/sourcedeps.ts`
- Modify: `src/core/index.ts` (export)
- Test: `test/core/sourcedeps.test.ts` (create)

- [ ] **Step 1: Extend types in `src/core/types.ts`**

In `ElementNode`, add after `inLoop?: boolean;`:

```ts
  /**
   * Raw definition source text for symbols this element references, resolved by the
   * adapter (null = referenced but unresolvable). Filled by the pipeline; core
   * normalizes + hashes it — adapters never produce hashes themselves.
   */
  symbol_sources?: Record<string, string | null>;
```

In `EntryDraft`, add after `disambiguator: string;`:

```ts
  /** Hashes of referenced symbol definitions (the L2 source-dependency layer). */
  symbol_defs: Record<string, string>;
```

- [ ] **Step 2: Write the failing test `test/core/sourcedeps.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { referencedSymbolNames, hashSymbolSources } from '../../src/core/sourcedeps';
import { normalizeSignals } from '../../src/core/signals';

describe('referencedSymbolNames', () => {
  it('collects handler names, bound-identifier roots, and the form_control root', () => {
    const sig = normalizeSignals({
      event_handlers: { click: 'saveOrder', blur: 'onBlur' },
      bound_identifiers: { data: 'order.customer.name', items: 'rows' },
      form_control: 'form.email',
    });
    expect(referencedSymbolNames(sig)).toEqual(['form', 'onBlur', 'order', 'rows', 'saveOrder']);
  });

  it('returns an empty list when no code-wired signals exist', () => {
    expect(referencedSymbolNames(normalizeSignals({ text: 'Save' }))).toEqual([]);
  });
});

describe('hashSymbolSources', () => {
  it('hashes definition text and skips unresolved (null) entries', () => {
    const defs = hashSymbolSources({ saveOrder: 'function saveOrder() { return 1; }', gone: null });
    expect(Object.keys(defs)).toEqual(['saveOrder']);
    expect(defs.saveOrder).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is whitespace-insensitive but comment-sensitive (safe over-flag)', () => {
    const a = hashSymbolSources({ f: 'function f() {\n  return 1;\n}' });
    const b = hashSymbolSources({ f: 'function f() { return 1; }' });
    const c = hashSymbolSources({ f: 'function f() { return 1; } // changed' });
    expect(a.f).toBe(b.f);
    expect(c.f).not.toBe(b.f);
  });

  it('changes when the definition body changes', () => {
    const a = hashSymbolSources({ f: 'function f() { return 1; }' });
    const b = hashSymbolSources({ f: 'function f() { return 2; }' });
    expect(a.f).not.toBe(b.f);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/core/sourcedeps.test.ts`
Expected: FAIL — module `../../src/core/sourcedeps` not found.

- [ ] **Step 4: Create `src/core/sourcedeps.ts`**

```ts
/**
 * Source-dependency policy (L2 of the dual-map spec §3.3).
 *
 * Core owns WHICH symbols an element depends on and HOW their definitions are
 * normalized + hashed. Adapters only resolve names to raw definition source text
 * (FrameworkAdapter.resolveSymbolDefs) — they can never fabricate hashes, keeping
 * the re-test trigger as tamper-proof as identity itself.
 *
 * Normalization is whitespace-collapse only; comments are intentionally NOT
 * stripped (naive stripping can corrupt string literals and silently under-flag).
 * A comment edit therefore over-flags a re-test — the safe direction.
 */
import { createHash } from 'node:crypto';
import { NormalizedSignals } from './types';

/** Leading identifier of an expression path: "order.customer.name" -> "order". */
function rootIdentifier(expr: string): string | null {
  const m = /^[A-Za-z_$][\w$]*/.exec(expr.trim());
  return m ? m[0] : null;
}

/** The symbol names an element's code-wired signals reference (sorted, deduped). */
export function referencedSymbolNames(sig: NormalizedSignals): string[] {
  const names = new Set<string>();
  for (const v of Object.values(sig.event_handlers)) {
    const r = rootIdentifier(v);
    if (r) names.add(r);
  }
  for (const v of Object.values(sig.bound_identifiers)) {
    const r = rootIdentifier(v);
    if (r) names.add(r);
  }
  if (sig.form_control) {
    const r = rootIdentifier(sig.form_control);
    if (r) names.add(r);
  }
  return [...names].sort();
}

/** Normalize a definition's source text: collapse all whitespace runs, trim. */
function normalizeDefText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Hash resolved definition sources; unresolved (null) entries are skipped. */
export function hashSymbolSources(sources: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(sources).sort()) {
    const text = sources[name];
    if (text == null) continue;
    out[name] = createHash('sha256').update(normalizeDefText(text), 'utf8').digest('hex').slice(0, 12);
  }
  return out;
}
```

- [ ] **Step 5: Export from `src/core/index.ts`**

Add `export * from './sourcedeps';` after the `./signals` export line.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/core/sourcedeps.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/sourcedeps.ts src/core/index.ts test/core/sourcedeps.test.ts
git commit -m "Add core source-deps policy: referenced-name selection and definition hashing"
```

---

### Task 2: Engine carries symbol_defs into drafts (fresh AND sticky)

**Files:**
- Modify: `src/core/engine.ts`
- Test: `test/core/engine.test.ts` (2 tests)

- [ ] **Step 1: Add failing tests inside `describe('generate', ...)` in `test/core/engine.test.ts`**

```ts
  it('hashes attached symbol sources into the draft', () => {
    const { drafts } = generate([
      node({
        tag: 'button',
        signals: { event_handlers: { click: 'saveOrder' } },
        symbol_sources: { saveOrder: 'function saveOrder() { return 1; }' },
      }),
    ], cfg);
    expect(Object.keys(drafts[0].symbol_defs)).toEqual(['saveOrder']);
    expect(drafts[0].symbol_defs.saveOrder).toMatch(/^[0-9a-f]{12}$/);
  });

  it('tracks symbol_defs for sticky elements too (id frozen, deps still tracked)', () => {
    const { drafts } = generate([
      node({
        tag: 'button',
        signals: { event_handlers: { click: 'saveOrder' } },
        existingId: 'x__button--save',
        symbol_sources: { saveOrder: 'function saveOrder() { return 1; }' },
      }),
    ], cfg);
    expect(drafts[0].sticky).toBe(true);
    expect(Object.keys(drafts[0].symbol_defs)).toEqual(['saveOrder']);
  });
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run test/core/engine.test.ts`
Expected: FAIL — `symbol_defs` is undefined on drafts (and the type now requires it, so typecheck of the engine also fails until Step 3).

- [ ] **Step 3: Implement in `src/core/engine.ts`**

Add the import: `import { hashSymbolSources } from './sourcedeps';`

In `generate`'s draft loop, the `common` object currently reads:

```ts
    const common = {
      component: p.node.component, tag: p.node.tag, element_type: p.long,
      identity: p.identity, identity_key: slugify(p.identityKey),
      fingerprint: p.fingerprint, signals: sig, loc: p.node.loc,
    };
```

Add `symbol_defs` to it:

```ts
    const common = {
      component: p.node.component, tag: p.node.tag, element_type: p.long,
      identity: p.identity, identity_key: slugify(p.identityKey),
      fingerprint: p.fingerprint, signals: sig, loc: p.node.loc,
      symbol_defs: hashSymbolSources(p.node.symbol_sources ?? {}),
    };
```

(Both the sticky branch and the fresh branch spread `...common`, so both get it.)

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run test/core/engine.test.ts`
Expected: PASS (all engine tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts test/core/engine.test.ts
git commit -m "Engine hashes attached symbol sources into drafts (fresh and sticky)"
```

---

### Task 3: Adapter contract + Vue resolveSymbolDefs

**Files:**
- Modify: `src/adapters/contract.ts` (optional method on `FrameworkAdapter`)
- Modify: `src/adapters/vue.ts` (implement it)
- Test: `test/adapters/vue.test.ts` (describe block)

- [ ] **Step 1: Extend `FrameworkAdapter` in `src/adapters/contract.ts`**

Add to the interface, after `customTagMap?`:

```ts
  /**
   * OPTIONAL L2 capability (dual-map spec §3.3): resolve template-referenced symbol
   * names to their definition SOURCE TEXT in this file's script. Return null for a
   * name that cannot be resolved (template-local, options API, etc.). Core — never
   * the adapter — normalizes and hashes the text. Adapters without this capability
   * simply produce no symbol_defs (name-only tracking, the pre-Phase-D behavior).
   */
  resolveSymbolDefs?(names: string[], source: string, file: string): Record<string, string | null>;
```

- [ ] **Step 2: Add failing tests at the END of `test/adapters/vue.test.ts`**

```ts
describe('VueAdapter.resolveSymbolDefs', () => {
  const SFC = `<template>
  <button @click="saveOrder">Save</button>
</template>

<script setup>
import { ref } from 'vue';
import { submit } from './api';
const email = ref('');
function saveOrder() {
  return submit(email.value);
}
</script>
`;
  const adapter = new VueAdapter();

  it('resolves a local function to its full definition text', () => {
    const defs = adapter.resolveSymbolDefs!(['saveOrder'], SFC, 'X.vue');
    expect(defs.saveOrder).toContain('function saveOrder()');
    expect(defs.saveOrder).toContain('submit(email.value)');
  });

  it('resolves a const binding to its declaration text', () => {
    const defs = adapter.resolveSymbolDefs!(['email'], SFC, 'X.vue');
    expect(defs.email).toBe("const email = ref('');");
  });

  it('resolves an imported name to its import statement only (L3 opaque boundary)', () => {
    const defs = adapter.resolveSymbolDefs!(['submit'], SFC, 'X.vue');
    expect(defs.submit).toBe("import { submit } from './api';");
  });

  it('returns null for template-local / unknown names', () => {
    const defs = adapter.resolveSymbolDefs!(['u', 'nope'], SFC, 'X.vue');
    expect(defs.u).toBeNull();
    expect(defs.nope).toBeNull();
  });

  it('returns all-null when there is no script setup', () => {
    const noScript = '<template><button @click="go">Go</button></template>';
    expect(adapter.resolveSymbolDefs!(['go'], noScript, 'Y.vue')).toEqual({ go: null });
  });
});
```

- [ ] **Step 3: Run to verify FAIL**

Run: `npx vitest run test/adapters/vue.test.ts`
Expected: FAIL — `resolveSymbolDefs` is undefined.

- [ ] **Step 4: Implement in `src/adapters/vue.ts`**

Update the lazy loader to also expose `compileScript`. Replace `loadVueParse`'s type/usages minimally: change the existing

```ts
type VueSfcParse = (source: string) => { descriptor: { template?: { ast?: VueNode } }; errors: unknown[] };

function loadVueParse(): VueSfcParse {
  try {
    return require('@vue/compiler-sfc').parse as VueSfcParse;
  } catch {
    ...
  }
}
```

to:

```ts
type VueSfc = {
  parse: (source: string, opts?: { filename?: string }) => { descriptor: any; errors: unknown[] };
  compileScript: (descriptor: any, opts: { id: string }) => { scriptSetupAst?: any[] };
};

function loadVueSfc(): VueSfc {
  try {
    return require('@vue/compiler-sfc') as VueSfc;
  } catch {
    throw new Error(
      'VueAdapter requires the optional peer dependency "@vue/compiler-sfc". Install it: npm i -D @vue/compiler-sfc',
    );
  }
}
```

and change the one call site in `parse` from `loadVueParse()(source)` to `loadVueSfc().parse(source)`.

Then add the method to the `VueAdapter` class (after `write`):

```ts
  /**
   * L2 resolver: map referenced names to their <script setup> top-level definition
   * text. Imported names resolve to their import statement only (opaque boundary);
   * names with no top-level declaration (template locals, options API) yield null.
   */
  resolveSymbolDefs(names: string[], source: string, file: string): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const n of names) out[n] = null;
    const sfc = loadVueSfc();
    const { descriptor } = sfc.parse(source, { filename: file });
    if (!descriptor.scriptSetup) return out;
    let ast: any[] | undefined;
    try {
      ast = sfc.compileScript(descriptor, { id: file }).scriptSetupAst;
    } catch {
      return out; // unparsable script: resolve nothing rather than something wrong
    }
    if (!ast) return out;
    const content: string = descriptor.scriptSetup.content;
    const slice = (node: any) => content.slice(node.start, node.end);
    for (const node of ast) {
      if (node.type === 'FunctionDeclaration' && node.id && names.includes(node.id.name)) {
        out[node.id.name] = slice(node);
      } else if (node.type === 'VariableDeclaration') {
        for (const d of node.declarations) {
          if (d.id?.type === 'Identifier' && names.includes(d.id.name)) out[d.id.name] = slice(node);
        }
      } else if (node.type === 'ImportDeclaration') {
        for (const s of node.specifiers ?? []) {
          if (names.includes(s.local?.name)) out[s.local.name] = slice(node);
        }
      }
    }
    return out;
  }
```

- [ ] **Step 5: Run to verify PASS**

Run: `npx vitest run test/adapters/vue.test.ts`
Expected: PASS (all vue tests + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/contract.ts src/adapters/vue.ts test/adapters/vue.test.ts
git commit -m "Vue adapter resolves referenced symbols to script-setup definition text"
```

---

### Task 4: Pipeline wires per-file resolution onto nodes

**Files:**
- Modify: `src/client/pipeline.ts`
- Test: `test/client/pipeline.test.ts` (end-to-end test)

- [ ] **Step 1: Add the failing end-to-end test inside `describe('runPipeline', ...)` in `test/client/pipeline.test.ts`**

Add the import at the top of the file: `import { VueAdapter } from '../../src/adapters/vue';`

```ts
  it('reports a symbol-definition change as modified while the id stays frozen', async () => {
    const v1 = `<template>
  <button @click="saveOrder">Save</button>
</template>

<script setup>
function saveOrder() { return 1; }
</script>
`;
    const transport = new LocalTransport(new InMemoryStorage());
    const adapter = new VueAdapter();
    const r1 = await runPipeline(adapter, transport, [{ file: 'X.vue', component: 'x', source: v1 }]);
    const tagged = r1.tagged[0].after;
    expect(tagged).toContain('data-testid="x__button--saveorder"');

    // Change ONLY the handler BODY; markup (and thus fingerprint) is untouched.
    const v2 = tagged.replace('return 1;', 'return 2;');
    await runPipeline(adapter, transport, [{ file: 'X.vue', component: 'x', source: v2 }]);

    const d = (await transport.diff(1, 2))!;
    expect(d.summary.modified).toBe(1);
    expect(d.modified[0].id).toBe('x__button--saveorder');
    expect(d.modified[0].changes.some((c) => c.field === 'symbol:saveOrder')).toBe(true);
  });
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run test/client/pipeline.test.ts`
Expected: FAIL — diff reports 0 modified (no symbol tracking wired yet). (It will keep failing until Task 5 lands the diff side; verify here that it fails for the expected reason: `summary.modified` is 0.)

- [ ] **Step 3: Wire resolution in `src/client/pipeline.ts`**

Add imports: `import { normalizeSignals, referencedSymbolNames } from '../core';`

After the parse step (and the existing `regenerate` mapping producing `nodes`), insert per-file resolution. The current code computes `parsed` then `nodes`; replace the section so it reads:

```ts
  const parsed = files.flatMap((f) => {
    const fileNodes = adapter.parse(f.source, f.file, f.component);
    // L2 source-deps: resolve each file's referenced symbols once, then attach the
    // per-node subset. Core picks the names and hashes the text; the adapter only maps
    // name -> raw definition source. Adapters without the capability skip this.
    if (adapter.resolveSymbolDefs) {
      const perNode = fileNodes.map((n) => referencedSymbolNames(normalizeSignals(n.signals)));
      const all = [...new Set(perNode.flat())].sort();
      if (all.length) {
        const resolved = adapter.resolveSymbolDefs(all, f.source, f.file);
        fileNodes.forEach((n, i) => {
          if (!perNode[i].length) return;
          const subset: Record<string, string | null> = {};
          for (const name of perNode[i]) subset[name] = resolved[name] ?? null;
          n.symbol_sources = subset;
        });
      }
    }
    return fileNodes;
  });
  // regenerate: drop existing ids so every element is freshly minted (and overwritten).
  const nodes = opts?.regenerate ? parsed.map((n) => ({ ...n, existingId: null })) : parsed;
```

- [ ] **Step 4: Commit (test still red until Task 5 — commit the wiring only)**

Run `npx vitest run test/core test/adapters` first to confirm no regression elsewhere, then:

```bash
git add src/client/pipeline.ts test/client/pipeline.test.ts
git commit -m "Pipeline resolves per-file symbol sources onto nodes (core-owned name policy)"
```

---

### Task 5: Registry persists symbol_defs; diff triggers on symbol changes

**Files:**
- Modify: `src/registry/storage.ts` (`RegistryEntry.symbol_defs`)
- Modify: `src/registry/registry.ts` (persist)
- Modify: `src/registry/diff.ts` (symbol-aware modified + changes)
- Modify: `test/helpers.ts` (`entry` default)
- Test: `test/registry/diff.test.ts` (2 tests)

- [ ] **Step 1: Add failing tests inside `describe('diff (exact identity match)', ...)` in `test/registry/diff.test.ts`**

```ts
  it('modified when only a symbol definition changed (fingerprint identical)', () => {
    const v1 = snapshot(1, { b: entry({ identity: 'x::button::save', fingerprint: 'F', symbol_defs: { saveOrder: 'aaa' } }) });
    const v2 = snapshot(2, { b: entry({ identity: 'x::button::save', fingerprint: 'F', symbol_defs: { saveOrder: 'bbb' } }) });
    const d = diff(v1, v2);
    expect(d.summary.modified).toBe(1);
    expect(d.modified[0].changes).toContainEqual({ field: 'symbol:saveOrder', old: 'aaa', new: 'bbb' });
  });

  it('unchanged when fingerprint and symbol_defs both match', () => {
    const v1 = snapshot(1, { b: entry({ identity: 'x::button::save', fingerprint: 'F', symbol_defs: { saveOrder: 'aaa' } }) });
    const v2 = snapshot(2, { b: entry({ identity: 'x::button::save', fingerprint: 'F', symbol_defs: { saveOrder: 'aaa' } }) });
    expect(diff(v1, v2).summary.unchanged).toBe(1);
  });
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run test/registry/diff.test.ts`
Expected: FAIL — `symbol_defs` not a known `entry` field / first test reports unchanged.

- [ ] **Step 3: Implement**

(a) `src/registry/storage.ts` — add to `RegistryEntry` after `disambiguator: string;`:

```ts
  symbol_defs: Record<string, string>;
```

(b) `src/registry/registry.ts` — in `reconcile`'s `entries[d.id] = {...}` add `symbol_defs: d.symbol_defs,` after `disambiguator: d.disambiguator,`.

(c) `test/helpers.ts` — in the `entry` factory defaults add `symbol_defs: {},`.

(d) `src/registry/diff.ts` — add a symbol differ and fold it into the modified decision. Add:

```ts
function diffSymbolDefs(a: Record<string, string> | undefined, b: Record<string, string> | undefined): SignalChange[] {
  const av = a ?? {}, bv = b ?? {};
  const changes: SignalChange[] = [];
  for (const name of [...new Set([...Object.keys(av), ...Object.keys(bv)])].sort()) {
    if (av[name] !== bv[name]) changes.push({ field: `symbol:${name}`, old: av[name] ?? null, new: bv[name] ?? null });
  }
  return changes;
}
```

In `diff`, replace the unchanged/modified branch:

```ts
    if (prev) {
      const symbolChanges = diffSymbolDefs(prev.symbol_defs, entry.symbol_defs);
      if (prev.fingerprint === entry.fingerprint && symbolChanges.length === 0) unchanged++;
      else modified.push({
        id, identity: entry.identity, component: entry.component,
        changes: [...diffSignals(prev.signals, entry.signals), ...symbolChanges],
      });
    }
```

- [ ] **Step 4: Run to verify PASS — including the Task 4 end-to-end test**

Run: `npx vitest run test/registry/diff.test.ts test/client/pipeline.test.ts`
Expected: PASS — including Task 4's "symbol-definition change as modified while the id stays frozen".

- [ ] **Step 5: Commit**

```bash
git add src/registry/storage.ts src/registry/registry.ts src/registry/diff.ts test/helpers.ts test/registry/diff.test.ts
git commit -m "Persist symbol_defs and trigger modified on symbol-definition changes"
```

---

### Task 6: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (container, outside the worktree)
- Test: full suite + typecheck + build + demos

- [ ] **Step 1: Full suite / typecheck / build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green (existing tests + ~12 new).

- [ ] **Step 2: Run both demos**

Run: `npm run demo && npm run demo:vue`
Expected: both run; `demo:vue` ids unchanged from before (symbol tracking adds registry data, never moves ids).

- [ ] **Step 3: Update `CLAUDE.md`**

Replace the line saying Phase D "is the remaining half — not yet built" with: Phase D increment 1 implemented — adapters may implement `resolveSymbolDefs` (Vue does, via `compileScript` bindings + `scriptSetupAst`); core selects names (`referencedSymbolNames`), hashes definitions whitespace-insensitively (`hashSymbolSources`), persists `symbol_defs`, and `diff` reports `symbol:<name>` changes as `modified` even when the fingerprint is identical — so a handler-body edit re-tests linked cases while the id stays frozen. Honest limits: imports hash their import statement only (L3 opaque); options-API/plain-`<script>`/Angular/React resolve nothing (name-only, as before).

- [ ] **Step 4: Commit tracked changes**

```bash
git add -A
git commit -m "Phase D increment 1 complete: source-dependency tracking verified"
```

(If only the untracked container `CLAUDE.md` changed, skip the commit and note it.)

---

## Self-review

- **Spec coverage:** §3.3 L1 (existing fingerprint — untouched), L2 (Tasks 1–5: name policy, adapter resolution, hashing, persistence, diff trigger), L3 boundary (import-statement-only hashing — Task 3 test) ✓. §3.4 decision rule: symbol change → `modified` → existing `affectedTests` routes `modified` to `re-test` with no change needed ✓. §3.5 data model: realized as the existing top-level `fingerprint` + new `symbol_defs` (noted deviation from the nested `source_deps` sketch — flat fields match the established entry shape) ✓. §4 honesty: unresolvable → null → skipped + degrade path documented ✓. Open question (normalization) resolved conservatively in the header ✓.
- **Placeholder scan:** none — every step has complete code and expected outcomes; Task 4's deliberately-red end-to-end test is explicitly tracked and turns green in Task 5 Step 4.
- **Type consistency:** `ElementNode.symbol_sources?: Record<string, string | null>` (Task 1) ← pipeline writes (Task 4), engine reads via `hashSymbolSources` (Task 2); `EntryDraft.symbol_defs: Record<string,string>` (Task 1) → reconcile persists (Task 5b) → `RegistryEntry.symbol_defs` (Task 5a) → `diffSymbolDefs` (Task 5d); `resolveSymbolDefs?(names, source, file)` signature identical in contract (Task 3 Step 1), Vue impl (Step 4), and pipeline call (Task 4). `SignalChange` reused for `symbol:<name>` fields — `affectedTestsToMarkdown`/`diffToMarkdown` render fields generically, no changes needed.
