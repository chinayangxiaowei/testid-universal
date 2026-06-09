# Phase B — Loop Detection + Component Slug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn when an element sits inside a loop (`v-for`/`*ngFor`) — where one static id is shared by every rendered instance — and slugify the `{component}` id token so ids are casing-consistent with identity.

**Architecture:** Adapters mark looped elements (`ElementNode.inLoop`); the engine emits a `loop-multiplicity` warning for them (restoring a capability the original tool has and our distillation dropped). Separately, the engine's mint slugifies the component token to match `identityOf`. No change to sticky behavior.

**Tech Stack:** TypeScript 5.x, Node 20+, Vitest 4. Run all commands from the `main/` worktree.

**Spec/Findings:** `docs/superpowers/specs/2026-06-09-sticky-testids-dual-map.md` §5 (Phase B); `docs/findings/2026-06-09-vue-lifecycle-findings.md` (A, B). Deferred from this phase: the tag-filter (findings C) — defaulting to skip non-interactive tags is opinionated; revisit later.

**Conventions:** Code/comments/commit messages in English. Single test file: `npx vitest run <path>`.

---

### Task 1: Engine emits a loop-multiplicity warning

**Files:**
- Modify: `src/core/types.ts` (`ElementNode.inLoop`; `Warning.code` union)
- Modify: `src/core/engine.ts` (emit the warning)
- Test: `test/core/engine.test.ts` (2 tests)

- [ ] **Step 1: Extend types in `src/core/types.ts`**

In the `ElementNode` interface, add (after `existingId?`):

```ts
  /** True when this element is inside a loop (v-for / *ngFor): one static id will be
   *  shared by every rendered instance. Set by the adapter. */
  inLoop?: boolean;
```

In the `Warning` interface, widen the `code` union from:

```ts
  code: 'unstable-identity' | 'positional-disambiguator';
```

to:

```ts
  code: 'unstable-identity' | 'positional-disambiguator' | 'loop-multiplicity';
```

- [ ] **Step 2: Add failing tests to `test/core/engine.test.ts`**

Append inside the existing `describe('generate', ...)` block (keep all existing tests; `cfg`, `node` in scope):

```ts
  it('warns about loop multiplicity for an element inside a loop', () => {
    const { warnings } = generate([
      node({ tag: 'button', signals: { event_handlers: { click: 'edit' } }, inLoop: true }),
    ], cfg);
    expect(warnings.some((w) => w.code === 'loop-multiplicity')).toBe(true);
  });

  it('does not emit a loop warning for a normal element', () => {
    const { warnings } = generate([
      node({ tag: 'button', signals: { event_handlers: { click: 'edit' } } }),
    ], cfg);
    expect(warnings.some((w) => w.code === 'loop-multiplicity')).toBe(false);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/core/engine.test.ts`
Expected: FAIL — no `loop-multiplicity` warning is emitted.

- [ ] **Step 4: Emit the warning in `src/core/engine.ts`**

In `generate`, inside the first `for (const node of nodes)` loop, immediately AFTER the existing `if (!key.stable && !node.existingId) { ... }` warning block, add:

```ts
    if (node.inLoop) {
      warnings.push({
        code: 'loop-multiplicity', element_type: long, identity,
        message: `${identity} is inside a loop (v-for / *ngFor): one static id is shared by every rendered instance. Bind a per-item id instead (e.g. a :data-testid bound to the item's key).`,
      });
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core/engine.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/engine.ts test/core/engine.test.ts
git commit -m "Engine warns about loop multiplicity for elements inside v-for/*ngFor"
```

---

### Task 2: Vue adapter detects `v-for` ancestry

**Files:**
- Modify: `src/adapters/vue.ts` (`parse` threads a loop flag)
- Test: `test/adapters/vue.test.ts` (1 test)

- [ ] **Step 1: Add a failing test to `test/adapters/vue.test.ts`**

Append a new `describe` block at the end of the file (the `VueAdapter` import already exists):

```ts
describe('VueAdapter.parse loop detection', () => {
  const SFC = `<template>
  <ul>
    <li v-for="x in items" :key="x.id">
      <button @click="pick(x)">Pick</button>
    </li>
  </ul>
</template>

<script setup>
function pick(x) { void x; }
</script>
`;
  const nodes = new VueAdapter().parse(SFC, 'List.vue', 'list');
  const by = (t: string) => nodes.find((n) => n.tag === t)!;

  it('marks the v-for element and its descendants as inLoop', () => {
    expect(by('li').inLoop).toBe(true);
    expect(by('button').inLoop).toBe(true);
  });

  it('leaves elements outside the loop unmarked', () => {
    expect(by('ul').inLoop ?? false).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/vue.test.ts`
Expected: FAIL — `inLoop` is `undefined` on the looped elements.

- [ ] **Step 3: Thread the loop flag through `parse` in `src/adapters/vue.ts`**

Replace the `parse` method with this version (the only changes: `visit` takes an `inLoop` parameter, computes `loop` from a `v-for` directive, sets `inLoop` on pushed nodes, and recurses with `loop`):

```ts
  parse(source: string, file: string, component: string): ElementNode[] {
    const root = loadVueParse()(source).descriptor.template?.ast;
    if (!root) return [];

    const nodes: ElementNode[] = [];
    const visit = (node: VueNode, inLoop: boolean) => {
      const hasFor = (node.props ?? []).some((p) => p.type === PROP_DIRECTIVE && p.name === 'for');
      const loop = inLoop || hasFor;
      if (node.type === NODE_ELEMENT && node.tag) {
        const attrs = readProps(node).attrs;
        const start = node.loc.start.offset;
        const tagEnd = source.indexOf('>', start);
        nodes.push({
          component,
          tag: node.tag,
          signals: normalize(node),
          existingId: attrs['data-testid'] ?? attrs['data-cy'] ?? null,
          loc: { file, start, end: tagEnd },
          inLoop: loop,
        });
      }
      for (const child of node.children ?? []) visit(child, loop);
    };
    visit(root, false);
    return nodes;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/vue.test.ts`
Expected: PASS (existing vue tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/vue.ts test/adapters/vue.test.ts
git commit -m "Vue adapter marks v-for elements (and descendants) as inLoop"
```

---

### Task 3: Slugify the `{component}` id token

**Files:**
- Modify: `src/core/engine.ts` (`render` slugifies component)
- Test: `test/core/engine.test.ts` (1 test)

- [ ] **Step 1: Add a failing test to `test/core/engine.test.ts`**

Append inside the existing `describe('generate', ...)` block:

```ts
  it('slugifies a PascalCase component in the id', () => {
    const { drafts } = generate([
      node({ component: 'LoginPage', tag: 'input', signals: { form_control: 'email' } }),
    ], cfg);
    expect(drafts[0].id).toBe('login-page__input--email');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/engine.test.ts`
Expected: FAIL — id is `LoginPage__input--email` (raw component token).

- [ ] **Step 3: Slugify the component token in `src/core/engine.ts`**

In `generate`, inside the fresh-mint branch, the `render` closure currently reads:

```ts
    const render = (dis: string) => formatId(config.idFormat, {
      component: p.node.component, element: slugify(p.short),
      key: slugify(p.identityKey), tag: p.node.tag, disambiguator: dis,
    });
```

Change `component: p.node.component,` to `component: slugify(p.node.component),` so it reads:

```ts
    const render = (dis: string) => formatId(config.idFormat, {
      component: slugify(p.node.component), element: slugify(p.short),
      key: slugify(p.identityKey), tag: p.node.tag, disambiguator: dis,
    });
```

(`slugify` is already imported. `identityOf` already slugifies the component, so identity strings are unchanged; this only aligns the minted id token. Sticky ids are unaffected — they are never re-minted.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/engine.test.ts`
Expected: PASS (all generate tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts test/core/engine.test.ts
git commit -m "Slugify the component token in minted ids (casing-consistent with identity)"
```

---

### Task 4: Full verification + CLAUDE.md note

**Files:**
- Modify: `CLAUDE.md` (container, one level above `main/`)
- Test: full suite + typecheck + build + demos

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS — all test files green (existing + the new loop/slug tests).

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: Run both demos**

Run: `npm run demo` and `npm run demo:vue`
Expected: both run without error. (Neither demo contains a loop, so no loop warning appears there; loop detection is covered by tests and observable on the `sim-vue-app` users table.)

- [ ] **Step 4: Update `CLAUDE.md` (container file, outside the worktree)**

Under "The identity model" / known-limitations area, add: the engine now emits a `loop-multiplicity` warning for elements inside `v-for`/`*ngFor` (a single static id is shared by every rendered instance — bind a per-item id), restoring a capability the original tool has; and minted ids now slugify the `{component}` token. Note the tag-filter (findings C) remains deferred.

- [ ] **Step 5: Commit any tracked changes**

```bash
git add -A
git commit -m "Phase B complete: loop-multiplicity warning + component slug verified"
```

(If `git status` shows nothing tracked because Step 4 only touched the untracked container `CLAUDE.md`, skip the commit and note that `CLAUDE.md` lives outside the repo.)

---

## Self-review

- **Spec/findings coverage:** loop detection + warning (findings A, spec §5 Phase B) → Tasks 1+2; slugify `{component}` (findings B) → Task 3; tag-filter (findings C) → explicitly deferred (stated in header). NORTH STAR tie-in: the loop warning serves "one id → exactly one element" by flagging the case where it would NOT hold.
- **Placeholder scan:** none — every code step shows complete code; commands have expected outcomes.
- **Type consistency:** `ElementNode.inLoop?: boolean` (Task 1) is read by `engine.generate` (Task 1) and set by the Vue adapter (Task 2); the `Warning.code` union gains `'loop-multiplicity'` (Task 1), which is the code asserted in the Task 1 tests and emitted in `generate`; `render`'s `component` argument change (Task 3) keeps the same `IdTokens` shape `formatId` expects.
