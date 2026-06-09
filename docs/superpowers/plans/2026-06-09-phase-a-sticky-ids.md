# Phase A — Sticky TestIDs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a written `data-testid` sticky — on re-tag, an element that already carries an id keeps it verbatim instead of being recomputed/overwritten — so locators never churn on edits.

**Architecture:** `engine.generate` honors `node.existingId` (adapters already capture it): such elements become "sticky" drafts whose id is the existing string; only id-less elements are freshly minted, and mints are guarded to never collide with sticky ids. Provenance is recorded as `source: 'sticky'`. A `--regenerate` escape hatch (pipeline + CLI) clears existing ids to force a re-mint.

**Tech Stack:** TypeScript 5.x, Node 20+, Vitest 4. Run all commands from the `main/` worktree.

**Spec:** `docs/superpowers/specs/2026-06-09-sticky-testids-dual-map.md` §3.1. This plan implements Phase A only (sticky ids). Phases B–D (loop detection, test-case map, source-dependency map) are separate plans.

**Conventions:** Code/comments/commit messages in English. Single test file: `npx vitest run <path>`.

---

### Task 1: Engine honors existing ids (sticky) + EntryDraft.sticky

**Files:**
- Modify: `src/core/types.ts` (`EntryDraft` gains `sticky: boolean`)
- Modify: `src/core/engine.ts` (rewrite `generate`)
- Test: `test/core/engine.test.ts` (add sticky cases)

- [ ] **Step 1: Add `sticky` to `EntryDraft` in `src/core/types.ts`**

In the `EntryDraft` interface, add the field (place after `fingerprint`):

```ts
  /** True when this id was taken verbatim from an already-written attribute (not minted). */
  sticky: boolean;
```

- [ ] **Step 2: Add failing tests to `test/core/engine.test.ts`**

Append these inside the existing `describe('generate', ...)` block (keep all existing tests):

```ts
  it('keeps an existing written id verbatim instead of recomputing', () => {
    const { drafts } = generate([
      node({ tag: 'input', signals: { form_control: 'email' }, existingId: 'legacy__input--whatever' }),
    ], cfg);
    expect(drafts[0].id).toBe('legacy__input--whatever');
    expect(drafts[0].sticky).toBe(true);
  });

  it('does not warn about a volatile key when the element already has an id', () => {
    const { warnings } = generate([
      node({ tag: 'button', signals: { text: 'Save' }, existingId: 'x__button--save' }),
    ], cfg);
    expect(warnings.some((w) => w.code === 'unstable-identity')).toBe(false);
  });

  it('mints a fresh id that does not collide with a sticky id of the same identity', () => {
    const { drafts } = generate([
      node({ tag: 'button', signals: { text: 'Save' }, existingId: 'login__button--save' }),
      node({ tag: 'button', signals: { text: 'Save' } }),
    ], cfg);
    const ids = drafts.map((d) => d.id);
    expect(ids).toContain('login__button--save');
    expect(new Set(ids).size).toBe(2);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/core/engine.test.ts`
Expected: FAIL — `drafts[0].id` is recomputed (`login__input--email`), `sticky` undefined, and a warning is emitted for the id-bearing button.

- [ ] **Step 4: Rewrite `generate` in `src/core/engine.ts`**

Replace the entire `generate` function (keep `shouldTag`, `GenerateResult`, the `Pre` interface, and `disambiguate` unchanged) with:

```ts
export function generate(nodes: ElementNode[], config: CoreConfig): GenerateResult {
  const warnings: Warning[] = [];
  const pre: Pre[] = [];

  for (const node of nodes) {
    if (!shouldTag(node, config)) continue;
    const sig = normalizeSignals(node.signals);
    const { short, long } = classify(node.tag, sig, config);
    const key = selectIdentityKey(sig, node.tag);
    const identity = identityOf(node.component, short, key.value);
    // Only warn about a volatile key for elements that will be freshly minted; an
    // element that already carries a written id is sticky and is never recomputed.
    if (!key.stable && !node.existingId) {
      warnings.push({
        code: 'unstable-identity', element_type: long, identity,
        message: `identity for ${identity} comes from "${key.source}" (volatile); add an explicit ${config.explicitKeyAttribute} key for a stable testid`,
      });
    }
    pre.push({ node, short, long, identityKey: key.value, stable: key.stable, fingerprint: fingerprintOf(node.tag, sig), identity });
  }

  // Sticky: elements that already carry a written id keep it verbatim. Reserve those
  // ids so freshly-minted ids can never collide with them.
  const taken = new Set<string>();
  for (const p of pre) if (p.node.existingId) taken.add(p.node.existingId);

  // Fresh elements (no written id) are grouped by identity for disambiguation.
  const freshByIdentity = new Map<string, Pre[]>();
  for (const p of pre) {
    if (p.node.existingId) continue;
    if (!freshByIdentity.has(p.identity)) freshByIdentity.set(p.identity, []);
    freshByIdentity.get(p.identity)!.push(p);
  }

  const drafts: EntryDraft[] = [];
  for (const p of pre) {
    const sig = normalizeSignals(p.node.signals);
    const common = {
      component: p.node.component, tag: p.node.tag, element_type: p.long,
      identity: p.identity, identity_key: slugify(p.identityKey),
      fingerprint: p.fingerprint, signals: sig, loc: p.node.loc,
    };

    if (p.node.existingId) {
      drafts.push({ id: p.node.existingId, sticky: true, ...common });
      continue;
    }

    const group = freshByIdentity.get(p.identity)!;
    const disambiguator = group.length > 1 ? disambiguate(p, group, warnings) : '';
    const render = (dis: string) => formatId(config.idFormat, {
      component: p.node.component, element: slugify(p.short),
      key: slugify(p.identityKey), tag: p.node.tag, disambiguator: dis,
    });
    let id = render(disambiguator);
    // Global uniqueness: never reuse an id already taken (sticky or an earlier mint).
    for (let n = 2; taken.has(id); n++) id = render(disambiguator ? `${disambiguator}-${n}` : String(n));
    taken.add(id);
    drafts.push({ id, sticky: false, ...common });
  }
  return { drafts, warnings };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core/engine.test.ts`
Expected: PASS (existing tests + 3 new = all green).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/engine.ts test/core/engine.test.ts
git commit -m "Engine honors existing written ids (sticky) and guards mint uniqueness"
```

---

### Task 2: Record `source: 'sticky'` in the registry

**Files:**
- Modify: `src/registry/storage.ts` (`RegistryEntry.source` union)
- Modify: `src/registry/registry.ts` (`reconcile` sets sticky source)
- Test: `test/registry/reconcile.test.ts` (add a sticky-source case)

- [ ] **Step 1: Widen `RegistryEntry.source` in `src/registry/storage.ts`**

Change the `source` field of `RegistryEntry` from:

```ts
  source: 'generated' | 'manual';
```

to:

```ts
  source: 'generated' | 'manual' | 'sticky';
```

- [ ] **Step 2: Add a failing test to `test/registry/reconcile.test.ts`**

Append inside the existing `describe('reconcile', ...)` block:

```ts
  it('records source "sticky" for a draft taken from an existing id', async () => {
    const storage = new InMemoryStorage();
    const stickyNode = () => node({ tag: 'input', signals: { form_control: 'email' }, existingId: 'login__input--email' });
    const { snapshot: s } = await reconcile(draftsFor(stickyNode()), storage, NOW);
    expect(s.entries['login__input--email'].source).toBe('sticky');
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/registry/reconcile.test.ts`
Expected: FAIL — source is `'generated'` (reconcile doesn't read `d.sticky`).

- [ ] **Step 4: Update the source determination in `src/registry/registry.ts`**

In `reconcile`, replace these two lines:

```ts
    const source: RegistryEntry['source'] = existing?.source === 'manual' ? 'manual' : 'generated';
    if (existing?.source === 'manual') overrides.push(d.id);
```

with:

```ts
    let source: RegistryEntry['source'];
    if (existing?.source === 'manual') {
      source = 'manual';
      overrides.push(d.id);
    } else {
      source = d.sticky ? 'sticky' : 'generated';
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/registry/reconcile.test.ts`
Expected: PASS (existing reconcile tests + new = all green).

- [ ] **Step 6: Commit**

```bash
git add src/registry/storage.ts src/registry/registry.ts test/registry/reconcile.test.ts
git commit -m "Record source 'sticky' for ids taken from existing attributes"
```

---

### Task 3: `--regenerate` escape hatch (pipeline + CLI) and end-to-end stickiness

**Files:**
- Modify: `src/client/pipeline.ts` (`runPipeline` gains a `regenerate` option)
- Modify: `src/cli.ts` (`--regenerate` flag on `tag`)
- Test: `test/client/pipeline.test.ts` (sticky-across-copy-edit + regenerate)

- [ ] **Step 1: Add failing tests to `test/client/pipeline.test.ts`**

Append inside the existing `describe('runPipeline', ...)` block (the imports for `runPipeline`, `LocalTransport`, `InMemoryStorage`, `HtmlTemplateAdapter` already exist in this file):

```ts
  it('keeps an element id stable across a copy edit (sticky)', async () => {
    const transport = new LocalTransport(new InMemoryStorage());
    const adapter = new HtmlTemplateAdapter();
    const r1 = await runPipeline(adapter, transport, [{ file: 'f.html', component: 'card', source: '<button>Save</button>' }]);
    const tagged = r1.tagged[0].after; // contains data-testid="card__button--save"
    expect(tagged).toContain('data-testid="card__button--save"');

    const edited = tagged.replace('>Save<', '>Save changes<');
    const r2 = await runPipeline(adapter, transport, [{ file: 'f.html', component: 'card', source: edited }]);
    expect(r2.tagged[0].after).toContain('data-testid="card__button--save"'); // id unchanged despite new text
  });

  it('re-mints ids from current signals when regenerate is set', async () => {
    const transport = new LocalTransport(new InMemoryStorage());
    const adapter = new HtmlTemplateAdapter();
    const r1 = await runPipeline(adapter, transport, [{ file: 'f.html', component: 'card', source: '<button>Save</button>' }]);
    const edited = r1.tagged[0].after.replace('>Save<', '>Save changes<');
    const r2 = await runPipeline(adapter, transport, [{ file: 'f.html', component: 'card', source: edited }], undefined, { regenerate: true });
    expect(r2.tagged[0].after).toContain('data-testid="card__button--save-changes"');
    expect(r2.tagged[0].after).not.toContain('card__button--save"');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/client/pipeline.test.ts`
Expected: FAIL — without sticky wiring the edited button id recomputes to `card__button--save-changes` in the first test; the second test fails because `runPipeline` takes no `regenerate` option.

- [ ] **Step 3: Add the `regenerate` option to `runPipeline` in `src/client/pipeline.ts`**

Change the function signature and the node-collection line. The current signature is:

```ts
export async function runPipeline(
  adapter: FrameworkAdapter,
  transport: TestIdTransport,
  files: { file: string; component: string; source: string }[],
  config?: Partial<CoreConfig>,
): Promise<{ tagged: TaggedFile[]; version: number; overrides: string[]; warnings: Warning[] }> {
```

Add a fifth parameter:

```ts
export async function runPipeline(
  adapter: FrameworkAdapter,
  transport: TestIdTransport,
  files: { file: string; component: string; source: string }[],
  config?: Partial<CoreConfig>,
  opts?: { regenerate?: boolean },
): Promise<{ tagged: TaggedFile[]; version: number; overrides: string[]; warnings: Warning[] }> {
```

Then replace the parse line. Current:

```ts
  const nodes = files.flatMap((f) => adapter.parse(f.source, f.file, f.component));
```

with:

```ts
  const parsed = files.flatMap((f) => adapter.parse(f.source, f.file, f.component));
  // regenerate: drop existing ids so every element is freshly minted (and overwritten).
  const nodes = opts?.regenerate ? parsed.map((n) => ({ ...n, existingId: null })) : parsed;
```

(The `Warning` type is already imported in this file.)

- [ ] **Step 4: Add the `--regenerate` flag to the CLI in `src/cli.ts`**

In `cmdTag`, find the line:

```ts
  const result = await runPipeline(adapter, transport, files, config);
```

and replace it with:

```ts
  const result = await runPipeline(adapter, transport, files, config, { regenerate: !!flags.regenerate });
```

(The CLI's `parseArgs` already turns a bare `--regenerate` into `flags.regenerate === true`; no other CLI change is needed. Document it in the usage line: append ` [--regenerate]` to the `tag` usage comment near the top of the file if present.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/client/pipeline.test.ts`
Expected: PASS (existing pipeline tests + 2 new = all green).

- [ ] **Step 6: Commit**

```bash
git add src/client/pipeline.ts src/cli.ts test/client/pipeline.test.ts
git commit -m "Add --regenerate escape hatch; sticky ids survive copy edits end to end"
```

---

### Task 4: Full verification + CLAUDE.md note

**Files:**
- Modify: `CLAUDE.md` (container, one level above `main/`) — note sticky behavior
- Test: full suite + typecheck + build + demos

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS — all test files green (existing + the new sticky/regenerate/source tests).

- [ ] **Step 2: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: Run both demos**

Run: `npm run demo` and `npm run demo:vue`
Expected: both run without error (the demos use fresh in-memory storage each run, so behavior is unchanged).

- [ ] **Step 4: Update `CLAUDE.md` (the container file, outside the worktree)**

Under the "The identity model" section, add a sentence: ids are now **sticky** — on re-tag an element that already carries a written `data-testid` keeps it (recorded as `source: 'sticky'`), so locators do not churn on edits; `--regenerate` (or deleting the attribute) forces a re-mint. Reference the spec `docs/superpowers/specs/2026-06-09-sticky-testids-dual-map.md` (Phase A).

- [ ] **Step 5: Commit the source-side change**

```bash
git add -A
git commit -m "Phase A complete: sticky ids verified (suite/typecheck/build/demos green)"
```

(If `git status` shows no tracked changes because Step 4 only touched the untracked container `CLAUDE.md`, skip the commit and note that `CLAUDE.md` lives outside the repo.)

---

## Self-review

- **Spec coverage (§3.1 Sticky id anchors):** existing written id wins → Task 1; `source: 'sticky'` → Task 2; `--regenerate` forced re-mint → Task 3; "no auto re-mint" → Task 1 (sticky branch never recomputes); unstable-identity warning downgraded to fresh-only → Task 1. Phases B–D are out of scope (separate plans), as the spec specifies.
- **Placeholder scan:** none — every code step shows complete code; commands have expected outcomes.
- **Type consistency:** `EntryDraft.sticky: boolean` (Task 1) is read by `reconcile` via `d.sticky` (Task 2); `RegistryEntry.source` union widened to include `'sticky'` (Task 2) matches what `reconcile` assigns; `runPipeline`'s new 5th param `opts?: { regenerate?: boolean }` (Task 3) is passed by the CLI (Task 3) and defaulted (`undefined`) by all existing callers, so their calls still type-check.
