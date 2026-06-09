# Deterministic, Stable TestID Identity for Automated Tests

Status: Proposed — 2026-06-09
Scope: redesign of the identity/fingerprint/diff core in `src/core` and `src/registry`,
plus a strict adapter contract. Adapter rewrites (Angular/React), test-runner glue, and
storage backends are out of scope.

## 1. Problem

testIds are the anchor for the e2e suite. Three properties decide whether that suite is
trustworthy and cheap to maintain:

- **Precision.** A selector `[data-testid="X"]` must resolve to **exactly one** element —
  never zero (stale id), never many (ambiguous id).
- **Stability.** An id must change **only when a relevant change happens to that element**.
  Unrelated edits — copy changes, restyling, edits to *other* elements — must not change
  it. Every id change forces test rework, so **id churn is the cost metric of the system**.
- **Safe adaptation.** When an id legitimately changes, the suite must fail **closed**
  (visible, ideally compile-time) and be guided to the new id — never silently match the
  wrong element or a missing one.

The current distilled implementation violates all three (see §3).

## 2. Goals / Non-goals

Goals:
1. Every emitted testid locates exactly one element (precision).
2. An element's id is a function of *its own stable signals*; unrelated changes never move
   it (stability / low churn).
3. id transitions are classified deterministically and drive a fail-closed test-update
   workflow (safe adaptation).
4. The identity standard and its ordering are **owned and enforced by core**; every adapter
   conforms to the same contract and cannot influence identity arbitrarily.

Non-goals (separate work): Angular/React adapter implementations, the test-runner
integration package, Postgres/multi-tenant storage, retention/rollback.

## 3. Current defects (grounded in code)

1. **Copy-driven key.** `DEFAULT_CONFIG.keyPriority` (`src/core/types.ts`) puts `aria_label`
   first and includes `text_content`; `keyFor` (`src/core/semantic.ts`) therefore derives
   the id `{key}` from display copy. Editing a button label changes its id.
2. **Cross-element id pollution.** `generate` (`src/core/engine.ts`) adds a hash suffix to
   **both** elements that share a base id with distinct fingerprints. Adding a *new* similar
   element B retroactively changes the id of the existing element A.
3. **Uniqueness hole.** Two genuinely identical sibling elements (same base id *and* same
   fingerprint) are not "contested", so both receive the **same** id. The selector then
   matches multiple elements.
4. **Copy inside the identity signal + impoverished signals.** `FINGERPRINT_ORDER`
   (`src/core/fingerprint.ts`) folds `aria_label`/`placeholder`/`text_content` into the
   fingerprint, and `SemanticHints` keeps only ~7 mostly display-oriented fields. The
   original tool (`spachtholz/TestID-Generator`, `src/tagger/fingerprint-generator.ts`)
   captures a far richer, code-wiring-dominated signal set (event handlers, bound
   identifiers, bound text paths, structural directives, child shape, context anchors,
   html id). We dropped all of it — the root cause of fragile identity.

## 4. Design

### 4.1 Closed signal schema (core-owned contract)

Adapters return a single closed structure, `RawSignals`. Core normalizes it (trim,
collapse whitespace, lowercase keys, sort maps) and derives both the identity and the
fingerprint. **No field in this structure is free-form with respect to identity**: identity
is computed only from named, typed slots; the one catch-all bucket feeds the fingerprint
only.

Signals are organized into stability tiers:

**Tier 0 — Explicit anchor (optional, highest)**
- `explicit_key` — an author-written stable handle (e.g. an authored `data-tid="login/submit"`).
  When present it *is* the identity; nothing else can move it.

**Tier 1 — Code-wired identity (stable; identity-eligible)**
- `form_control` — Angular `formControlName` / Vue `v-model` target / React controlled `name`
- `name`
- `route` — `routerLink` / `:to` / `<router-link to>` / `href`
- `event_handlers` — map of `event -> handler function name` (e.g. `click -> saveOrder`)
- `bound_identifiers` — map of `input -> identifier path` (e.g. `data -> currentOrder`),
  including loop item bindings
- `html_id` — the element `id` attribute (page-unique by spec; strong disambiguator but
  often a cryptic slug, so ranked low for the readable key)
- `structural` — structural-directive / control-flow conditions (`*ngIf`, `@if`, `v-if`,
  loop keys)

**Tier 2 — Structural / relational (fairly stable; disambiguators only, never the primary key)**
- `child_shape` — tag sequence of immediate element children
- `context` — nearest label/legend/heading anchors
- `semantic_css` — class tokens, with utility/Tailwind-shaped classes demoted

**Tier 3 — Display copy (volatile; excluded from identity)**
- `text` / `aria_label` / `placeholder` / `title` / `alt` / `value` / `type` / `role`
- `static_attributes` — bounded catch-all for any remaining static attribute.
  **Feeds the fingerprint only. Never contributes to identity.**

Every element also carries `tag`, `element_type` (short + long classification), `component`,
and source `loc` for write-back.

### 4.2 Two derived artifacts: identity vs fingerprint

The single most important change is to **decouple identity from fingerprint**:

- **identity** — the stable matching key. Built only from stable slots. Used for *exact*
  cross-version matching. Cosmetic edits never change it.
- **fingerprint** — a rich descriptive signature built from **all** tiers (including copy
  and `static_attributes`), in a fixed canonical order. Used only to detect `modified` and
  to produce a field-level "what changed" report. Never used for matching.

### 4.3 identity-key priority (the order)

The `{key}` token (and the identity key) is the first non-empty value walking this list.
Confirmed ordering — code-wired signals first, `html_id` low, copy last:

1. `explicit_key`
2. `form_control`
3. `name`
4. `route`
5. `event_handlers` (deterministic pick: prefer `click`, `submit`, `change`, `input`, else
   first by sorted key)
6. `bound_identifiers` (deterministic pick: prefer `data`, `value`, `model`, `item`, `items`,
   else first by sorted key)
7. `html_id`
8. `structural`
9. `child_shape`
10. `text`
11. `aria_label`
12. `placeholder`
13. fallback: `tag`

If the chosen key comes from Tier 3 (entries 10–12) or falls back to `tag`, core emits a
**stability warning** for that element ("no stable identity signal; add an explicit key"),
because such an id will churn on copy edits.

### 4.4 identity definition, uniqueness, registry-stable disambiguation

```
identity = component + element_type.short + slug(identity_key) [+ disambiguator]
```

- **Uniqueness guarantee.** If two elements in one parse produce the same identity, core
  appends a disambiguator so each emitted id is unique. Disambiguation prefers a *distinct
  stable signal not already in the key* (e.g. a differing `bound_identifier`, `html_id`, or
  `route`) before resorting to a positional sibling index. A positional fallback emits a
  stability warning (it churns when siblings are added/removed) and recommends an explicit
  key.
- **No cross-element pollution.** An element's id is a pure function of its own signals.
  Adding or removing element B never changes element A's id (fixes defect #2), because A and
  B with different identities never interact. The only coupling is between *same-identity*
  elements via the disambiguator.
- **Registry-stable assignment for same-identity collisions.** When same-identity elements
  must be disambiguated and a prior registry exists, the incumbent keeps its assigned suffix
  and the newcomer takes the next free one (assignment is registry-aware *only* for this
  disambiguator step; identity itself stays a pure function).

### 4.5 Diff semantics (deterministic, exact identity match)

Matching is by **exact identity equality** across versions — no Levenshtein, no threshold:

- identity in both, fingerprint equal → **unchanged**
- identity in both, fingerprint differs → **modified**, reported with the **exact set of
  fingerprint fields that changed** (e.g. `text: "Sign in" -> "Login"`). The id is
  unchanged, so the test still locates the element; the field-level report tells you whether
  an *asserted* field changed.
- identity only in new → **added** (write a test)
- identity only in old → **removed** (retire the test)
- **renamed** becomes rare and, when it occurs, is driven by a *stable* signal actually
  changing. The fuzzy similarity matcher is retained **only** as an advisory suggestion that
  must be confirmed by a human; it is never auto-applied to test code.

Because copy is excluded from identity, the common "edit the label" case is now a `modified`
with a stable id — not a rename guess.

### 4.6 Enforcement ("adapters cannot fill arbitrarily")

1. `RawSignals` is a **closed TypeScript type**. Identity-eligible slots are named and typed;
   there is no free-form field that can reach identity. The only catch-all
   (`static_attributes`) is structurally confined to the fingerprint.
2. Core runs a single `normalize + validate` pass on adapter output. Malformed output
   (missing `element_type`, wrong shapes, empty map values, copy placed in a code slot where
   detectable) is **rejected with an error**, not silently accepted.
3. The priority chain, disambiguation strategy, and hashing live entirely in core. Adapters
   have no API to change them.
4. An adapter's only responsibilities are: in `parse`, map framework vocabulary into the
   correct slots; and `write` the attribute back.

### 4.7 Uniform across adapters

The signal extraction *shape*, identity rules, fingerprint, and diff all live in
`core`/`registry`. Each adapter (HTML, Vue, and future Angular/React) only translates its
framework's vocabulary into `RawSignals`. This is the "same calculation method in every
adapter" requirement: a Vue `v-model` and an Angular `formControlName` both land in
`form_control`, and identity is computed identically thereafter.

### 4.8 Safe test-adaptation workflow

- Tests reference **generated id constants** (e.g. `testIds.loginInputEmail`), not hardcoded
  strings. A removed or renamed id makes the constant disappear → the test fails to compile
  → fail-closed, never a silent runtime mismatch.
- `diff` output is mapped to a per-id **test action**: `unchanged` (none), `modified`
  (review only if a changed field is asserted), `added` (new test), `removed` (retire test),
  `renamed` (advisory; confirm, then the constant carries the new value).

## 5. What changes in the code

- `src/core/types.ts` — replace the thin `SemanticHints` with the tiered `RawSignals`
  contract; split `keyPriority` (identity-key order) from fingerprint composition; add a
  `warnings` channel.
- `src/core/semantic.ts` — `selectKey`/`keyFor` walk the new identity-key priority; copy
  demoted to last resort; emit stability warnings.
- `src/core/fingerprint.ts` — fingerprint over all tiers in a fixed order (rich,
  descriptive); identity computed separately from stable slots only.
- `src/core/engine.ts` — id = identity (+ stable-preferring disambiguator); remove the
  both-sides hash flip; guarantee per-element uniqueness.
- `src/registry/registry.ts` — registry-aware disambiguator assignment so incumbents keep
  ids; carry `warnings`.
- `src/registry/diff.ts` — match by exact identity; field-level `modified` report; demote
  similarity to advisory.
- `src/adapters/*` — adapt HTML and Vue adapters to emit `RawSignals`; the Vue adapter gains
  event-handler / bound-identifier / structural extraction from the compiler AST.

## 6. Migration / compatibility

This changes the fingerprint and the id-key derivation, so ids and fingerprints from any
existing registry will shift. The project is pre-1.0 with no production registries, so this
is a one-time reset rather than a migration: bump the registry schema version and regenerate.
No backwards-compatibility shim.

## 7. Risks & tradeoffs

- **Copy-only elements.** An element with no Tier 0–2 signal (e.g. a bare
  `<button>Save</button>`) can only be keyed by copy or position; it cannot be 100% stable
  without an `explicit_key`. The design surfaces this as a warning rather than hiding it.
- **Positional disambiguation churn.** Truly identical repeated elements with no
  distinguishing stable signal fall back to a sibling index, which churns when siblings are
  added/removed. Mitigated by preferring stable disambiguators and by the warning.
- **Adapter effort.** Rich signal extraction is more work per adapter than the old regex
  scan. Accepted: it is the price of stable identity and is shared logic where possible.

## 8. Open implementation questions (resolve in the plan)

- Exact concrete name/attribute for `explicit_key` per framework (e.g. `data-tid`).
- Whether the stability `warnings` are returned in the tag response, written to the
  registry, or both.
- The precise generated-constants format the test workflow consumes (ties into the locators
  generator).
