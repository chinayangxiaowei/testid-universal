# Findings — first real-scale run: RealWorld/Conduit Vue 3 (2026-06-11)

Target: `mutoe/vue3-realworld-example-app` (1.1k stars, 22 SFCs, 20 of them
`<script setup>` + TS), cloned to the container as `real-conduit/`, tagged on its
`testid-integration` branch. First run at ~7x the sim's scale immediately surfaced three
issues the sim never hit — all fixed the same day (commit `722cd31` in `main`).

## Numbers (post-fix run)

- 22 files parsed, **98 registry entries**, 0.83s wall for the whole pipeline.
- **36 entries carry `symbol_defs`** — Phase D engages on real composable-based code.
- **7 entries `source: 'sticky'`**: the project already had hand-written `data-testid`
  attributes; the tool preserved them verbatim, unprompted — the sticky contract holding
  against pre-existing real-world ids.
- Warnings: ~17 `loop-multiplicity` (articles/comments/tags/nav lists — Conduit is v-for
  heavy), ~12 `unstable-identity` (loading/empty-state copy), 8 `positional-disambiguator`
  (4 author-link pairs). Volume is readable and actionable, not overwhelming.

## Issues found at scale (all fixed + regression-tested)

1. **BUG — `<template #slot>` wrappers were tagged.** `<template #fallback>` got a
   `data-testid` — but `<template>` never renders, so the id is dead (a test querying it
   finds nothing) and it pollutes the registry. The HTML adapter always skipped
   `template`; the Vue adapter missed it. Fix: skip `template` elements (children still
   visited).
2. **BUG — punctuation-only text minted empty keys.** `<span>({{ count }})</span>` →
   static text `()` → slug `''` → id `articledetailmeta__span--` (trailing separator,
   collision-prone, identity tail empty). Fix: a key whose slug is empty falls back to
   the tag (unstable-warned): `...__span--span`.
3. **QUALITY — raw bound expressions leaked into keys.** `:disabled="!form.email ||
   !form.password"` produced `login__button--form-email-form-password` and defeated
   symbol-root extraction (`!` prefix → no root). Fix: the Vue adapter reduces bind
   expressions to their **first identifier path** (`form.email`) — matching the original
   tool's identifier-path approach — yielding `login__button--form-email` and restoring
   symbol tracking for such elements.

## Patterns worth noting

- **Form fields generated in a `v-for`** (Login/Register/Settings render fields from a
  config array) — so even *inputs* are loop-shared here. The loop warning fires correctly;
  per-field targeting in such apps requires the bound-id pattern. This is a more common
  real-world shape than the sim suggested.
- Suspense fallbacks / loading branches produce most of the unstable-identity noise;
  `skipTags` already silences the heading/label class of it, and the rest is genuinely
  copy-keyed UI that tests rarely target.

## Conclusion

At real scale the pipeline is fast, the warning volume is workable, Phase D engages, and
sticky honors pre-existing ids. The three fixes close the gap between "works on the sim"
and "works on a popular real codebase". Next natural steps on this target: bound-id the
v-for fields, add `data-tid` to the author-link pairs, and stand up the CI gates per the
integration spec.
