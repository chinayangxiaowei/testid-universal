# One-hop source-dependency tracking (`dep_defs`)

Status: implemented. Extends Phase D of `2026-06-09-sticky-testids-dual-map.md`.
Origin: downstream report — on a real React 18 app, editing `createOrder` in `api.js`
(called by the `submit` handler) produced `diff: unchanged`, so `affected` routed no
re-test. The most frequent real change path (handler → service / hook / store) sat
exactly in the old boundary.

## Decision

Move the honest boundary from "directly referenced definitions" to "directly referenced
definitions **plus one hop**". Layer 3+ stays untracked. On by default; `--no-deps`
(`runPipeline(..., { deps: false })`) opts out.

Why default-on: off-by-default would leave the false sense of safety in place for every
user who does not know to enable it. Why an opt-out exists: large monorepos may want to
cap re-test volume, and it isolates the feature when diagnosing an over-flag.

## What one hop covers

For each symbol an element references (layer 1, `symbol_defs`), the shared resolver
(`src/client/deps.ts`, framework-agnostic, babel AST) collects the references its
definition makes and hashes the definition text of each, keyed `<symbol>><ref>`:

| Shape | Key | Text hashed |
| --- | --- | --- |
| same-file helper / same-class method | `submit>validate` | the helper's declaration |
| imported function (named / default) | `submit>createOrder` | the exported declaration in the target module |
| namespace import | `submit>api.createOrder` | the `createOrder` export |
| template-referenced import | `createOrder>createOrder` | its exported declaration |
| destructured hook | `save>useOrders` | the hook's declaration |
| store / hook instance alias | `claim>tasks.claimTask` | alias declarator + only the `claimTask` member (store action / returned fn); whole factory if the member is not found |
| package factory alias (`ref`, `computed`, `useRouter`) | `submit>email.value` | the declarator only (packages are out of scope) |
| Angular injected service (`constructor(private svc: S)` / `inject(S)`) | `submit>svc.create` | the `create` method of class `S` |

Module resolution: relative paths; nearest `tsconfig.json`/`jsconfig.json` `paths` +
`baseUrl` (JSONC tolerated); extension and `index.*` probing. Re-export chains
(`export *`, `export { a as b } from`, import-then-export) are followed to the real
declaration (≤ 8 hops, cycle-guarded) — a barrel is plumbing, not a layer.

## Adapter seam

One optional method: `scriptContext(source, file) → { code, path } | null`.
React: the JSX file. Vue: `<script>` + `<script setup>` (imports resolve from the `.vue`
path). Angular: the companion `.ts`. Adapters do no dependency analysis themselves; core
only hashes text (`hashSymbolSources`), so adapters still cannot fabricate hashes.

## Registry & diff semantics

- `ElementNode.dep_sources` → `EntryDraft.dep_defs` → `RegistryEntry.dep_defs`
  (optional field; absent when tracking was off or unsupported).
- `diff` reports `dep:<key>` only for keys present on **both** sides with different
  hashes. A key appearing/disappearing means either the handler's own text changed
  (already reported as `symbol:<name>`) or tracking was toggled / newly resolvable —
  neither is a behavior change of a known dependency. This makes upgrades and `--no-deps`
  toggles noise-free (verified on the fast-team registry: v16→v17 0 modified).
- Routing needs no change: every `modified` entry becomes `re-test` in `affected`.

## Honest boundary (documented in README / USAGE)

- Not followed: the dependency's own calls (layer 3), bare packages, dynamic dispatch.
- **Reported, not followed (`dep_limited`).** For each hop-1 definition the resolver
  collects what IT references in its own module (local helpers, relative/aliased imports,
  injected services, `this.<m>()` on an options object) plus dynamic dispatch anywhere in
  the handler or hop-1 body (`obj[key]()` with a non-literal key, calling a parameter).
  Labels: `<sym>><ref>><layer3>` / `<sym>>[<ref>>](dynamic) <callee>`. Bare packages and
  globals stay silent. Stored per entry as `dep_limited` (never hashed, never diffed —
  toggling it is noise-free); `tag` prints the list, `affected` appends a "Beyond
  tracking depth" section naming the tests to fall back to. Function parameters inside a
  definition shadow same-named module bindings (the module index is name-level, not
  scope-aware), which also removed false hop-1 deps such as `(t) => t.id` → another
  function's `const t`.
- A local-looking import that cannot be resolved (unknown alias, missing file or export)
  is reported by `tag` as UNRESOLVED — never silently treated as unchanged.
- Cross-file changes are only seen when the dependent file is in the `tag` run. Tag the
  whole tree; changed-files-only runs miss them. (Future: persist dep files per entry to
  enable reverse lookup.)
- Granularity: an element whose layer-1 root IS the store alias (`v-model="tasks.query"`)
  depends on the whole store definition — a safe over-flag.

## Validation

- 19 tests in `test/client/deps.test.ts` (React / Vue / Angular, every shape above,
  barrels, aliases, third-hop non-tracking, unresolved reporting, upgrade and toggle
  noise-freedom, member precision); a mutation disabling dep comparison turns 9 red.
- Downstream repro via the CLI: `affected` routes exactly `order.spec.ts::submits an order`.
- fast-team (real Vue/Pinia app): upgrade 0 modified; editing the `claimTask` store action
  routes the two claim cases (+ the search box bound to the store object — documented
  over-flag) and nothing else.
