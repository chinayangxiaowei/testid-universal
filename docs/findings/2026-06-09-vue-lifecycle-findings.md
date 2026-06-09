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
