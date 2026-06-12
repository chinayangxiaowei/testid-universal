# React adapter acceptance: real-history replay on react-redux-realworld

**Venue.** `gothinkster/react-redux-realworld-example-app` (clone at container
`real-conduit-react/`, 59 commits, 2016–2021, class-component/Redux era, JSX in `.js`
files — exercised via `--ext .js --adapter react`). Branch `r-ours`, base `7cb5876`
(post-CRA restructure), 14 real commits replayed with the established
`merge -X theirs` method. No original-tool column: TestID-Generator is Angular-only,
so this acceptance is capability validation, not head-to-head.

Baseline: 118/256 elements tagged (131 no-signal, 7 policy-skipped); positional groups
warned (nav links); `<Route>` elements get ids too — statically indistinguishable from
DOM-rendering components, documented as acceptable noise.

| Step | Result |
| --- | --- |
| **Y1 "fix favouriting in article preview"** | **`symbol:handleClick` → 1 modified on the FIRST step** — a behavior fix inside the same `.js` file, id and JSX untouched; same-file L2 works from day one |
| Y2–Y4, Y7–Y8, Y12–Y14 (redux store, logger, actionTypes, **React 16 upgrade**) | zero noise |
| Y5 "pagination accepts pager function" | 6 modified, field-attributed: `attr:{pager}` raw-prop changes + `symbol:clickHandler` ×2 — a props-contract refactor routed precisely |
| Y6 "Fix warnings" | merge destroyed 10 tags; 6/6 genuine add/remove, rest re-minted identically |
| **Y10 react-router v4 migration** | merge destroyed **40 of 118** tags; result: 85 unchanged (deterministic re-mint), 23 modified (`attr:{to}` — the router API change), 10/10 added/removed. A major framework migration with **zero locator churn on surviving elements** |
| Y11 "typo of sign up button" | 1 modified (`text`) — copy noise contained at fingerprint level |

No new gaps surfaced — the two fixes mined from the Angular replays (raw expressions
into `static_attributes`; export-default unwrap in L2) were designed in from the start,
and the arrow-handler resolution (`onClick={() => pick(it)}` → `pick`, AST-based — a
regex would capture the parameter) covered the idiomatic React patterns.

React-specific limits (documented): one JSX source node renders N runtime instances —
identity is props-only and instances share one id (`.map()` ancestry still warns
`loop-multiplicity`); router/config components (`<Route>`) are tagged like any custom
component because "renders DOM" is not statically decidable.
