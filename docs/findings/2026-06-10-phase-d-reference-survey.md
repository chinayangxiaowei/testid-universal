# Findings — Phase D reference survey: resolving template symbols to script definitions (2026-06-10)

Question: for Phase D (testID → source-dependency map at *definition* level), what existing
source implementations are useful references, and what should we actually build on?

## Decisive result: `@vue/compiler-sfc` already provides the load-bearing machinery (verified by probe)

Executed against our installed `@vue/compiler-sfc@3.5.x` (already our optional peer dep):

`compileScript(descriptor, { id })` returns BOTH of the two things Phase D needs:

1. **`bindings`** — the official map of template-visible names to binding kinds:
   ```
   { email: 'setup-ref', isBusy: 'setup-ref', saveOrder: 'setup-const',
     submit: 'setup-maybe-ref', ref: 'setup-const', computed: 'setup-const' }
   ```
   - Distinguishes locally-defined bindings from imported ones (`submit` from `./api`
     shows as `setup-maybe-ref` via its ImportDeclaration) — the L3 "imports are opaque"
     boundary falls out of the data naturally.
   - Names NOT in this map (e.g. a `v-for` item variable like `u` in `@click="edit(u)"`)
     are template-locals — exactly the filter we need to avoid resolving loop variables.
2. **`scriptSetupAst`** — a Babel AST of the `<script setup>` content with **exact source
   ranges per top-level declaration**. Probe output:
   ```
   [FunctionDeclaration] saveOrder :: range 144-198
     source: "function saveOrder() {\n  return submit(email.value);\n}"
   [VariableDeclaration] isBusy :: range 93-143  ("const isBusy = computed(...)")
   [ImportDeclaration] import:submit :: range 38-69 ("import { submit } from './api';")
   ```
   Slicing the declaration text for hashing is direct; no extra parser needed.

**Conclusion: Phase D (Vue-first) requires ZERO new dependencies.** The resolver is:
referenced name → (in `bindings`? else skip as template-local) → find covering top-level
declaration in `scriptSetupAst` → slice source → normalize (strip comments / collapse
whitespace) → hash. Imported names hash their import-specifier text (opaque, per spec L3).

## Other references surveyed (semantics references, not dependencies)

- **Original `spachtholz/TestID-Generator`** — confirmed (2026-06-10 deep analysis): stops
  at template-visible names everywhere; nothing to reuse for definition resolution.
- **`vue-eslint-parser` / `eslint-plugin-vue`** (e.g. `vue/no-unused-properties`): performs
  real template↔script reference linking with scope analysis. Best *semantic* reference for
  edge cases (shadowing, v-for/v-slot locals, destructured composables). Not worth taking
  as a dependency — `bindings` covers our need — but consult its rules when defining which
  names count as script-resolvable.
- **Volar (`vuejs/language-tools`)** — full go-to-definition via virtual TS files; the most
  complete solution to our exact problem but far too heavy as a dependency. Reference only.
- **TS compiler API / ts-morph** — the right tool LATER for Angular (component-class
  members) and React (function-scope bindings); unnecessary for Vue `<script setup>`.
- **Nx "affected" model** — conceptual prior art for hash-based change→retest routing, but
  file-granular; validates the approach, we go symbol-granular.

## Design inputs this fixes for the Phase D spec/plan

1. Resolver inputs: the root identifiers of `event_handlers` values, `bound_identifiers`
   values, and `form_control` (v-model target) from `RawSignals` — filtered through
   `bindings` to drop template-locals.
2. Definition hash: normalized source slice of the covering top-level declaration;
   for `<script>` (non-setup) and options API: out of scope for the first increment
   (degrade to name-only and report the gap, per spec §4 honesty rule).
3. Imported symbols: hash the ImportDeclaration text only (detects source-module/specifier
   changes, not the imported body) — matches the documented L3 boundary.
4. Storage: `source_deps.symbol_defs: Record<name, hash>` per spec §3.5; diff extends the
   re-test trigger (spec §3.4) with symbol-level changes.
