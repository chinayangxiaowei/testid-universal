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

## Patch-stream simulation (2026-06-12) — upstream history as the developer, us as the test side only

Method: branched Conduit at its 2020 build-up commit (`3b23542`, 3 SFCs) and replayed
**8 real upstream commits** (P1–P8: flatten refactor, pagination, preview abstraction,
fetch tags, article page, popular-tags refactor, login+register, login logic) by landing
each commit's `src` wholesale, then doing ONLY test-side work: re-tag → diff → affected →
regenerate constants → tsc gate → sync specs. No sticky ids survive a wholesale landing,
so this is the pure **identity-stability** stress (the "tag-in-CI, tags not committed
upstream" workflow variant).

Results per step (registry v1→v9):
- **P1 (flatten refactor)**: file renames changed component names (`Footer/index.vue` →
  `Footer.vue`); footer ids correctly retired+reborn; the one retired id our spec used was
  routed (`retire | index__link--https-thinkster-io | home.spec.ts`) and the tsc gate fired
  with TypeScript itself suggesting the migration (`Did you mean
  'footerLinkHttpsThinksterIo'?`). One-line spec fix, green.
- **P2–P6** (features + refactors): registry advanced cleanly; none of the ids our specs
  referenced were touched; **zero spec changes, tsc green at every step** — feed-toggle and
  banner ids stayed identity-stable across five real commits including two refactors.
- **P7 (login+register)**: write-new flood for the new pages → responded by adding a login
  spec.
- **P8 (login logic)**: mixed change — the template part flagged (`re-test |
  login__form--onlogin`); the store internals (separate files; 2020 era has no
  `<script setup>`) correctly produced no signal, matching the documented L2/L3 boundary.

Simulation-mechanics note (not a tool bug): per-step landing must clear `src/` before
`git checkout <sha> -- src`, or renamed-away files linger and mask retirements.

Verdict: with no written ids to lean on, the identity model alone kept every
spec-referenced anchor stable through 5 unrelated commits, surfaced the genuine breakage
exactly once (component rename), and the constants+tsc gate made that breakage impossible
to miss. The "patches as the developer, tool as the test side" loop is viable.

## Patch stream extended (2026-06-12) — P9–P13, through 14 months of drift to the script-setup era

- **P9 (AppLink replaces RouterLink + nav abstraction)**: the feed toggle moved into a
  config-driven `ArticlesNavigation` (v-for) — both spec-referenced feed links retired,
  both routed to `home.spec.ts`, tsc double-killed them; spec migrated to a count-level
  assertion on the shared loop id. 35 write-new / 16 retire absorbed otherwise untouched.
- **P10–P11** (settings/editor pages; favorites/tags/follow logic): green, zero spec edits.
- **P12 (RELEASE JUMP — one step over ~14 months to `88c65af^`)**: 56 write-new / 47 retire
  (upstream renamed components to `App*`). The only two spec-referenced casualties were
  routed precisely, and `tsc` again *named the successors* (`Did you mean
  'appnavigationApplinkLinkName' / 'appfooterLinkHttpsThinksterIo'?`). Login anchors
  survived the entire 14 months untouched. Two sed-level fixes, green.
- **P13 (`88c65af` — upgrade to script setup)**: **zero retire, zero write-new** — the
  migration moved code, not identity, and every id held. The diff instead showed exactly
  the expected **one-time symbol-onboarding wave**: 35 `re-test` rows
  (`symbol:<name> null→hash`) as 35/89 entries gained definition hashes ({} baseline →
  populated). Conservative direction (re-test once), and symbol-level tracking is live
  from this version on. Note: this wave is distinct from the `symbol_defs === undefined`
  pre-upgrade suppression — an empty-but-recorded baseline genuinely transitioned.

Final registry: v14 across 13 landed upstream states. Verdict unchanged and strengthened:
identity carried the anchors through a year-plus of real development including two mass
renames, the gates caught every genuine breakage with compiler-suggested fixes, and the
symbol layer switched itself on at the precise commit where the codebase made it possible.
