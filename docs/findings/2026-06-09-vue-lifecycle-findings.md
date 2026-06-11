# Findings — testid-universal on a real Vue app lifecycle (2026-06-09)

Source experiment: a standalone Vue 3 app in a sub-git (`sim-vue-app/`, sibling of `main/`,
its own git history) tagged with the `VueAdapter` across v1 (initial) → v2 (copy edits) →
v3 (add field). These are real, reproducible findings, listed by priority.

## A. CRITICAL — `v-for` elements get one static id but render N times, silently

A `v-for` row and its per-row buttons each receive a single id
(`UsersTable__button--edit`, `UsersTable__tr--u-id`, …). At runtime every row carries the
same `data-testid`, so a `getByTestId(...)` matches N elements (Playwright strict-mode
error, or wrong row). No warning is emitted, because the elements have "stable" identities
from `@click`/`:key`. This is the Vue analogue of the documented React `.map()` caveat, but
silent. It breaks the core "one id → exactly one element" guarantee for lists/tables — the
most common real-world structure.

Fix direction: VueAdapter should detect `v-for` ancestry from the compiler AST and either
skip auto-tagging the repeated subtree or emit a dedicated warning recommending a bound
per-item id (`:data-testid="`user-row-${u.id}`"`); optionally support a bound explicit key.

## B. BUG — the `{component}` id token is not slugified

Ids are PascalCase from the filename (`LoginPage__…`, `UsersTable__…`) while their own
identity strings are slugified (`loginpage::…`, `userstable::…`). Casing disagrees, and two
files differing only by case/separators would share an identity but emit different id bases
(latent cross-identity collision). An earlier fix slugified `{element}` but missed
`{component}`.

Fix: in `engine.generate`'s `formatId` call use `component: slugify(p.node.component)`
(matches `identityOf`). One line.

## C. NOISE/DESIGN — text-only elements churn on copy edits, and there are many

A copy edit to a code-wired element keeps its id (reported `modified`); a copy edit to a
text-only element (`<h1>`) churns (remove + add, unlinked). By design and warned — but a
3-file toy app already produced 6 `unstable-identity` warnings (h1 / th / label / a
handler-less button), most of which are rarely e2e targets.

Fix direction: a default "don't tag these tags" set (`h1`–`h6`, `th`, `label`) or an
interactive-only mode to cut warning noise and avoid churn on non-targets.

## D. GAP — the bundled CLI cannot tag `.vue`

`src/cli.ts` hardcodes `HtmlTemplateAdapter`; there is no adapter selection, so a Vue
project cannot use `testid tag` and must script the library directly.

Fix: select the adapter by file extension (`.vue` → VueAdapter) or via `--adapter`.

## E. POSITIVE — additive and code-wired changes behave as designed

Adding a field → diff shows exactly `1 added, 0 churn`. Elements with `v-model` / `@click` /
`@submit` / `router-link to` get stable, copy-independent ids. The core value holds.

## Priority

1. **A** v-for runtime ambiguity (silent) — blocks lists/tables.
2. **D** CLI cannot do Vue — blocks the basic Vue workflow.
3. **B** component not slugified — trivial correctness fix.
4. **C** tag-filter to cut warning noise — ergonomics.

## F. Phase D simulation (2026-06-10) — source-dependency re-test triggering works end to end

Lifecycle v4→v6 on the same sim app, with the Phase D tool (symbol_defs tracking):

1. **v4 baseline over a pre-Phase-D registry: ZERO migration noise.** diff v3→v4 =
   20 unchanged / 0 modified; the run silently recorded the symbol baseline.
2. **v5: edited ONLY `onSubmit`'s body** (template untouched). 0 files rewritten, all ids
   frozen; diff flagged exactly the 2 elements wired to it (`LoginPage__form--onsubmit`,
   `LoginPage__button--onsubmit`) as `modified { symbol:onSubmit }`. The other 18 stayed calm.
3. **v6: changed `email = ref('')` initial value** (the `v-model` target's declaration).
   diff flagged exactly `LoginPage__input--email` as `modified { symbol:email }` — and the
   `onSubmit`-wired elements stayed calm even though `onSubmit`'s body *reads* `email`,
   demonstrating the documented boundary: element→symbol direct references only, no
   symbol→symbol transitive following (spec §3.3 L3).

This is the NORTH STAR's second half working on real project data: tests can be routed to
re-test from a pure script-side behavior change, with ids (locators) completely stable.

## Status update (2026-06-11)

- **A — FIXED** (Phase B): `v-for` ancestry now emits a `loop-multiplicity` warning, and an
  author-bound `:data-testid` is respected (element skipped, never minted beside).
- **B — FIXED**: the `{component}` id token is slugified.
- **C — FIXED**: `DEFAULT_CONFIG.skipTags` (`h1`–`h6`, `th`, `label`) skips minting for
  copy-only presentation tags unless the element carries a `data-tid` or an existing id
  (sticky ids are still honored, so previously tagged elements are not retired).
- **D — FIXED**: the CLI picks the adapter from the file set (`.vue` → `VueAdapter`,
  otherwise HTML; `--adapter` overrides), so `testid tag src --ext .vue` works.
- **E** still holds; **F** added above.

## G. Real-runner integration (2026-06-11) — closed with actual Playwright

The sim app was made runnable (vite + vue-router) with a real Playwright suite anchored
exclusively on generated constants. Verified in a real browser: (1) green 3-test baseline;
(2) a handler-body edit routed and selectively re-ran ONLY `login.spec.ts` via
`affected --out-list`; (3) removing an element made `tsc` fail at the exact stale
reference (TS2339 on the vanished constant) and `affected` routed `retire` to the same
file; retiring the case restored green. Management loop exercised end to end:
`write-new` prompts creation, `re-test` drives selective re-runs, the compiler enforces
retirement. The v-for shared-id limitation surfaced honestly (count-level assertions only).
