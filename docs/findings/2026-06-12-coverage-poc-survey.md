# Findings — coverage POC survey: the original tool, and the wider ecosystem (2026-06-12)

Question (after the 9.3%-coverage reality check): did the original `TestID-Generator`
have an adequacy/coverage capability we failed to port? And how do other testing
ecosystems measure "how many test-worthy elements are covered"?

## 1. The original tool: NO adequacy capability existed — nothing was missed in porting

Full grep of `TestID-Generator/src` + wiki for coverage/unused/orphan/unreferenced/untested:

- `locators/migration-report.ts` + `generator.ts:478-515` — **orphan locator FILES**:
  generated `.py` files whose component no longer exists. Artifact staleness, not coverage.
- `migrate/report.ts` / `tagger.ts:77` — **"STILL REFERENCED" orphan variables**: ids that
  vanished while tests still reference them. That is the *staleness* direction (our
  fail-closed constants + `retire` routing already supersede it, and harder: compile error
  vs. a textual warning with exit 0).
- Wiki: zero hits.

**Conclusion: both codebases shared the adequacy blind spot.** The original answers
"which test references are stale?" — never "which tagged elements have no test at all?".
Our `coverage` command is new capability, not a missed port.

## 2. Ecosystem survey

- **Cypress UI Coverage** (commercial, Cypress Cloud + Test Replay) — the direct analog
  and the most developed approach: a **runtime DOM-based** report marking every
  interactive element tested/untested, with a score = tested / total interactive.
  Interactivity is defined by HTML semantics + WAI-ARIA roles + `tabindex >= 0`. Zero
  instrumentation, but requires running the full suite against their cloud.
- **Code coverage for e2e** (Playwright `page.coverage` / V8 / Istanbul plugins): a
  different axis entirely — lines of frontend code executed, not elements covered.
  Chromium-only, awkward to merge; complements rather than replaces element coverage.
- **Feature / requirement traceability** (tests mapped to user stories): manual,
  process-level; no element granularity.
- Testim/mabl: self-healing selectors, dashboards; no published element-coverage metric.

## 3. Where our approach sits, and what is worth borrowing

Ours is **static and registry-based**: denominator = tagged ids (per source element),
covered = referenced by ≥1 test. Strengths vs Cypress's runtime model: no app run needed,
zero infrastructure, CI-gateable in milliseconds (`coverage --min N`), exact source-level
work list, and the companion `tag` stats expose elements that never got an id at all.
Honest weaknesses vs the runtime model:

1. **"Referenced" is weaker than "interacted"** — a constant imported but never acted on
   counts as covered for us; Cypress counts actual interactions. Borrowable increment: a
   Playwright fixture/reporter that records which testids `getByTestId` actually touched
   at runtime → upgrade the metric from *referenced* to *exercised* (and catches dynamic
   bound ids that the static map cannot see).
2. **Interactivity definition** — we use an element_type regex; Cypress uses HTML
   semantics + ARIA roles + tabindex. Borrowable: include `role` (already a signal slot)
   and explicit interactive roles in the interactive classification.
3. **Runtime-only elements** (third-party widgets, portals) are invisible to a build-time
   registry by design — periodic full runs + (1) are the mitigation.

Both improvements recorded as backlog; neither blocks the current gate, which already
closes the "green but untested" hole at the source level.

## Implementation note (same day) — both borrowed increments landed and validated live

1. **Interactive classification** now = tag semantics ∪ ARIA interactive roles ∪
   `tabindex >= 0`. Acceptance on Conduit v14: the real `<i role="button">`
   delete-comment icon (`articledetailcomment__i--emit`) — previously classified
   non-interactive — now counts (interactive denominator 54 → 55, ⚠-flagged). It had
   been TAGGED all along (role is a signal); only the coverage classifier missed it.
2. **Runtime exercised coverage**: zero-dep `createTestIdRecorder()` (wraps any
   page-like `getByTestId`, parallel-safe line artifact) + `coverage --runtime FILE`.
   Validated on the live Conduit Playwright suite: 3 real tests recorded 8 exercised
   ids; the report now answers three tiers — referenced (5), referenced-but-never-
   exercised (0), and **exercised dynamic ids outside the registry (3:
   `article-preview-article-{1,2}`, `pop-tag-vue`)** — closing the dynamic-bound-id
   blind spot that static scanning cannot see.

## Coverage-driven simulation round (same day) — the new toolchain driving real work

A full round on the live Conduit suite where every action was dictated by tool output,
one commit per analysis step (`real-conduit` `testid-integration`, see its
`COVERAGE-LOG.md`):

| Commit | Tool signal acted on | Result |
| --- | --- | --- |
| C1 baseline | tag stats 97/216 tagged (111 no-signal); static 8.8% interactive; `--min 30` exit 1; runtime: 5 exercised, 3 dynamic | worklist derived from the ⚠ table |
| C2 | top ⚠ cluster (register form, 5 ids) | register.spec → **17.5%**, 4 tests green |
| C3 | next clusters (nav/footer links; favorite button interaction via mocked POST) | nav.spec + favorite-click → **22.8%**, 6 tests green |
| C4 | achievable floor | gate frozen at `--min 20` (exit 0 now; ratchets coverage) |

Throughout: referenced-but-never-exercised stayed **0** (the suite acts on everything it
references) and the 3 dynamic bound ids stayed visible only via `--runtime` — exactly the
division of labor the two coverage layers were designed for. Remaining ⚠ clusters
(settings/editor/article-detail) are auth/route-gated and logged as deferred work, not
silently dropped.
