# Sticky TestIDs + Dual-Map Test-Maintenance Bridge

Status: Proposed — 2026-06-09
Relationship: realizes the NORTH STAR in `CLAUDE.md`. Builds on the identity model in
`docs/superpowers/specs/2026-06-09-stable-testid-identity-design.md` and the empirical
findings in `docs/findings/2026-06-09-vue-lifecycle-findings.md`.

## 1. Goal

Make `data-testid` a reliable bridge for automated-test maintenance: after any code change,
determine **precisely and trustworthily which e2e test cases must be rebuilt, modified, or
removed**. Two halves, both required:

1. **Locator integrity** — each testID is a stable, unique, precise anchor (one id → exactly
   one element); a test always finds its element; added/removed elements are reported exactly.
2. **Re-test triggering** — flag a test for re-test **even when its id did not change**,
   because the *source the testID maps to* changed.

## 2. Why the current state is insufficient

- The current engine **recomputes the id from signals on every run and overwrites** the
  attribute. So a copy edit to a text-keyed element churns its id → false "test must change"
  and broken locators. (The original `spachtholz/TestID-Generator` avoids this by *freezing*
  written ids — see findings.)
- **An id change is necessary but not sufficient** as a "test needs work" signal. A test can
  go stale with the id unchanged: the element's handler/validator/binding *definition* changed
  but its name (and thus the fingerprint's symbol *name*) did not. Neither the current tool nor
  the original detects a changed *definition body* — both only track symbol names.
- There is **no testID → test-case mapping**, so even a clean id change can't be routed to the
  specific tests that depend on it.

## 3. Design

Three components plus a decision rule. They compose; each is independently shippable.

### 3.1 Sticky id anchors

On re-tag, an element that **already carries a written `data-testid`** keeps it — the written
id wins and is never recomputed/overwritten. Only an element with **no** id gets a fresh one,
minted via the existing identity/stable-key heuristic (+ group-coherent disambiguation) and
written once.

- The source file is the durable id store; the registry records provenance + history + the
  source-dependency hashes (below).
- Effect: locators never churn on edits (copy, restyle, sibling add/remove, even a genuine
  identity change) — matching the original tool's stability, which we lost by recomputing.
- The stable-key heuristic still governs the **first** id's readability; thereafter the id is
  frozen. The `unstable-identity` warning is downgraded to advisory ("first id derived from
  volatile copy; consider an explicit `data-tid` before it sticks").
- **Forced regeneration** is explicit only: a `--regenerate` flag (or deleting the attribute)
  re-mints. Never automatic — automatic re-mint is the churn we are removing.
- Implementation: `engine.generate` must honor `node.existingId` (adapters already capture it)
  instead of ignoring it; `reconcile` marks such entries `source: 'sticky'` and still updates
  their source-dependency hashes.

Edge case — *name rot*: a frozen id can become semantically stale (id reads `--sign-in` on an
element now showing "Welcome back"). Accepted: stability of the test anchor outranks a
self-describing name. The re-test signal (3.3) and `--regenerate` are the mitigations.

### 3.2 testID → test-case map (fail-closed)

Know which tests reference which id.

- Tests reference **generated id constants** (e.g. `testIds.loginButtonSubmit`) emitted by the
  locators generator, not hardcoded strings. A removed/renamed id makes the constant vanish →
  the test **fails to compile** (fail-closed), never a silent runtime mismatch.
- The map is built by scanning the test sources for references to the generated constants (and,
  as a fallback, raw id strings). Output: `id → [test file:case]`.
- This is what turns "id removed/added/changed" into "these specific tests are obsolete / need
  writing / need repointing."

### 3.3 testID → source-dependency map (definition-level)

Detect "the source behind this id changed" even when the id is frozen. Two tiers, with a hard
boundary at the third.

- **L1 — markup (already have it).** The element's own attributes = the existing `fingerprint`.
  A markup change is the existing `modified` + field-level change list. No new work.
- **L2 — directly-referenced symbol definitions (the new layer).** For each symbol the element
  references — event handler (`@click="saveOrder"`), bound identifier (`[data]="currentOrder"`),
  form-control validator, pipe — resolve it to its **definition in the co-located component
  script** and store a hash of that definition's source. When `saveOrder`'s *body* changes
  (same name), its hash changes → flag. This is strictly more than name-tracking, which both
  existing tools already do.
  - Per-framework adapter responsibility: `resolveSymbolDefs(referencedSymbols, script) →
    Record<name, defHash>`. Vue: parse `<script setup>` for the named declaration's span.
    Angular: resolve component-class members. React: resolve via the component function scope.
- **L3 — transitive dependencies: NOT followed (the honest boundary).** If `saveOrder` calls a
  service/API/shared util and only *that* changes, it is **not** detected. Following the call
  graph is fragile and explosive; we stop at directly-referenced definitions. Optionally, an
  imported module's export-signature hash MAY be tracked as a coarse proxy, but semantic-level
  transitive change is out of scope and must be documented, never implied.

### 3.4 Re-test decision rule

Per id, comparing version N → N+1:

| Condition | Signal | Test action |
| --- | --- | --- |
| id present only in N+1 | added | write new test(s) |
| id present only in N | removed | retire test(s) |
| id in both, `fingerprint` (L1) OR any `symbol_defs` (L2) changed | modified / source-changed | **re-test linked cases** (report which markup fields and/or which symbols changed) |
| id in both, L1 + L2 unchanged | unchanged | none |

Output: a "re-test report" — the set of test files/cases to revisit, grouped by trigger
(locator gone, new element, markup change, symbol-definition change), each citing the exact id
and what changed.

### 3.5 Data model

`RegistryEntry` gains a source-dependency record:

```
source_deps: {
  fingerprint: string;               // L1 — already exists, reused as the markup hash
  symbol_defs: Record<string, string>; // L2 — referenced symbol name -> definition hash
}
```

The testID → test-case map is a separate generated artifact (not in the registry), produced by
scanning tests. `source: 'generated' | 'manual' | 'sticky'`.

## 4. Honest boundaries & limits

1. **Transitive (L3) changes are invisible** (service/API/shared-util bodies). Documented limit.
2. **Over-flagging is by design and safe**: hashing a definition body flags re-test even for a
   behavior-preserving refactor (renamed local var). Bias toward over-flag (re-test is safe;
   missing a real change is not).
3. **Name rot** from sticky ids (3.1). Mitigated by the re-test signal + explicit `--regenerate`.
4. **Per-framework symbol resolution** is real work and exists only where an adapter implements
   it; absent it, L2 degrades to name-only (current behavior) and that gap must be reported.

## 5. Phasing (each phase ships value; each gets its own implementation plan)

- **Phase A — Sticky ids.** Honor `existingId`; `source: 'sticky'`; `--regenerate`. Removes
  copy-edit churn immediately. (Small–medium.)
- **Phase B — Loop / `v-for` detection + warning.** Restore the loop-warner we regressed vs the
  original (findings A); also slugify `{component}` (findings B) and a tag-filter (findings C).
  Prereq for trustworthy lists. (Small.)
- **Phase C — testID → test-case map + generated id constants + fail-closed.** Completes the
  locator half. (Medium.)
- **Phase D — source-dependency L2 (symbol-definition tracking), Vue first.** Completes the
  behavior half within the documented boundary. (Medium–large.)

Phases A–C are mostly mechanical; D carries the design risk (per-framework symbol resolution)
and should be planned on its own after A–C land.

## 6. Open questions for the plans

- Exact attribute for the explicit/forced key and for `--regenerate` ergonomics.
- Generated-constants format and how the locators generator emits + the test-map scanner reads it.
- L2 definition-hash normalization (whitespace/comment-insensitive? — likely yes, to avoid
  flagging pure formatting).
- Whether `source_deps` lives in the registry only or is also surfaced in the tag response.
