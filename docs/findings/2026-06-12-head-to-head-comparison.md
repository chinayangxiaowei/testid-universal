# Findings — head-to-head: original TestID-Generator vs testid-universal on an identical commit stream (2026-06-12)

Venue: `sim-angular-app` (the only venue both tools can parse — the original is
Angular-only). Two branches from the same clean commit (`cmp-original`, `cmp-ours`),
the SAME scripted edits applied to both (attribute-position-independent, verified
non-no-op), each tool run after every step, registries committed per step.

Steps: S0 baseline · S1 two copy edits (h1 + submit button) · S2 add a `phone` input ·
S3 remove the forgot link · S4 semantic rename + attribute re-mint
(`displayName → fullName`, id deleted) · S5 add a `Reset` button next to `Cancel`.

## Raw results

| Step | Original (23 entries @S0) | Ours (12 entries @S0) |
| --- | --- | --- |
| S0 | 2 collisions, **5 loop warnings**, tags 23/23 elements | 0 collisions needed, **0 loop warnings**, tags 12/23 (6 no-signal, 5 policy-skipped — reported by tag stats), **6 unstable-identity hints** |
| S1 copy ×2 | churn 0; **modified = 7** (context-anchor ripple from one heading) | churn 0; **modified = 1** (the button, field-level `text`); h1 untracked by `skipTags` policy |
| S2 add field | added 1, modified 1 (`child_shape`) | added 1, modified 0 |
| S3 remove link | removed 1, modified 1 | removed 1, modified 0 |
| S4 rename+re-mint | **renamed = 1** (fuzzy link, with confidence) + modified 1 | **added 1 + removed 1** (deterministic; the vanished constant breaks compilation instead) |
| S5 add button | added 1, modified 1, collisions 2→3 | added 1, modified 0, no collision (distinct text keys) |

## Comparison data, by dimension

1. **Locator churn (the shared core promise)**: identical — **0 source rewrites in every
   step for both** (original freezes written ids; ours is sticky). Tie.
2. **Re-test signal precision**: total `modified` flags across S1–S5: original **11**,
   ours **1** — and the one is exactly the element whose own copy changed, with the
   changed field named. The original's context anchors make one heading edit flag 7
   elements; routed to tests, that is a 7× re-test bill for a copy change. Ours wins
   decisively on signal precision.
3. **Rename handling (S4)**: philosophical fork. Original: fuzzy advisory link
   (`renamed=1`, confidence) — helpful, fail-open. Ours: deterministic retire+write-new,
   with the constants gate turning it into a compile error — no guess, fail-closed.
   Different answers to the same event; ours matches the NORTH STAR's trust requirement.
4. **Loop detection (this venue): original wins.** 5 `*ngFor` warnings vs our 0 — our
   loop detection lives only in the Vue adapter; the HTML adapter has no `*ngFor`/`@for`
   ancestry detection. **Actionable gap, recorded as backlog.**
5. **Tagging surface**: original tags everything (23/23, incl. h1/th/td/label) via its
   rich open-ended fingerprint; ours tags 12/23 by closed-contract + `skipTags` policy
   *and accounts for the rest* (tag stats: 6 no-signal, 5 policy). Completeness vs
   noise-reduction-with-accounting — a deliberate difference, not a defect, but worth
   knowing: the original would let you target an h1; ours asks for a `data-tid` first.
6. **Guidance**: ours emitted 6 actionable unstable-identity hints; the original none
   (freezing makes them moot for ids — but the hints also drive coverage hygiene).
7. **Outside the overlap (qualitative)**: ours-only — field-level modified detail,
   symbol-definition layer (Vue), generated constants + fail-closed, affected-test
   routing, static+runtime coverage with gates, `--check`. Original-only — fuzzy rename
   suggestions, backup/rollback, retention, activity log, Robot locator merge/migration.

## Measurement notes (honesty)

- First run was invalidated twice by harness bugs of ours (zsh word-splitting; seds
  written against untagged sources silently no-oping on tagged files) — fixed with a
  python edit script asserting non-no-op. Numbers above are from the corrected run.
- Found in passing: our `tag --check` returns before printing warnings — minor gap, logged.

## Verdict

On the shared promise (stable anchors, honest change reporting) the tools tie on churn
and ours leads 11:1 on re-test precision; the original leads where we haven't ported its
breadth (HTML/Angular loop detection — to fix; safety nets — backlog by choice). S4
crystallizes the philosophical difference: suggestion-with-confidence vs
deterministic-and-fail-closed.

## Post-comparison fixes (same day)

Both actionable gaps surfaced by this comparison are closed (commit `9edab11`, 127 tests):

1. **HTML adapter now detects `*ngFor` subtrees** (naive closing-tag range scan, consistent
   with the adapter's documented text-extraction approach) and marks elements `inLoop`.
   Re-validated on the comparison venue: ours now emits **3 loop warnings** on the users
   table (td + Edit/Delete buttons; the bare `tr`/inner `td` carry no signal and are not
   tagged, hence not warned — vs the original's 5 which include untagged-by-us elements).
   Dimension 4 of the comparison moves from "original wins" to "near-parity, scoped to
   what each tool tags".
2. **`tag --check` now prints identity warnings** before its verdict, so the CI gate
   surfaces hygiene findings instead of swallowing them.
