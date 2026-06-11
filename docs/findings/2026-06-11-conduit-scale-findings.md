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

## Issue 4 (CRITICAL, found in iteration R0) — ">" inside attribute values corrupted writes

`@update="newArticle => updateArticle(index, newArticle)"` — the arrow `>` inside the
attribute value made the adapter's naive `indexOf('>')` mis-detect the opening-tag end and
inject `data-testid` INSIDE the expression, breaking the file (Vue compile error). Arrow
functions in handlers are everywhere in real code; the sim never used one in a multi-line
attribute. Fix (regression-tested): search for the opening tag's `>` only past the last
prop's AST end offset.

## Iteration log — daily-development simulation on Conduit (R0–R3, all real-browser)

- **R0 baseline**: constant-driven Playwright suite (login form + mocked-API home feed)
  green on the real app; network isolated via route mocks. Found+fixed Issue 4.
  Real-world friction noted: the host repo's lint-staged pre-commit rejects out-of-project
  files (commit integration changes with `--no-verify` or extend its tsconfig).
- **R1 hygiene**: replaced two loop-shared static ids with bound per-item ids
  (`article-preview-<slug>`, `pop-tag-<tag>`). Tagger respected the bindings (skip);
  diff → `retire` routed precisely to `home.spec.ts`; the tsc gate fired on the vanished
  constant; spec rewritten to per-row assertions (`getByTestId('article-preview-article-1')`)
  — the loop limitation properly engineered away.
- **R2 feature**: added a demo-credentials button → `write-new | login__button--filldemoaccount`
  (handler-keyed, stable); new spec added; suite green.
- **R3 behavior change**: edited ONLY `fillDemoAccount`'s body → id frozen, diff
  `re-test { symbol:fillDemoAccount }` routed to `login.spec.ts`; selective real-browser
  re-run green. (Fail-closed retire was already exercised in R1 on this same project.)

Verdict: the full daily loop — hygiene, feature, behavior change, retirement — runs on a
popular real codebase with the dual-map signals doing the routing, and every iteration
either passed or surfaced a tool bug that was fixed the same day.
