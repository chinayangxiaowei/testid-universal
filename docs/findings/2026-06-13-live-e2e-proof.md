# Live end-to-end proof: real browser, real recorder, real coverage

Every prior validation stopped at the `affected` list — the loop was proven by
simulation, never by a running browser. This closes that gap: a served app, a real
Chromium run via `@playwright/test`, the recorder producing **real exercised ids**, and
`coverage --runtime` merging them. Harness: container-level `e2e-proof/` (see its
`README.md` to reproduce).

## Setup

Three faithful static Conduit pages (`app/{index,settings,editor}.html`, untagged
source) served by a 30-line zero-dep node static server on `:4317`. Tagged with the tool
(HTML adapter), constants generated, specs written against `createTestIdFixture` (the
shipped Playwright fixture) + the generated `testIds`.

```
testid tag app --ext .html         -> data-testid written into the served DOM (v1: 27/52 tagged)
testid gen-constants --out ...      -> tests/testids.generated.ts
npx playwright test                 -> real Chromium, fixture records every getByTestId
testid coverage --runtime .testids-runtime
```

## What actually ran

```
Running 3 tests using 1 worker
  ✓ auth › sign in with an email shows a status (137ms)
  ✓ auth › empty email is rejected (76ms)
  ✓ settings › update settings saves the username (89ms)
  3 passed (1.4s)   [+1 skipped editor spec]
```

The recorder wrote `.testids-runtime` with the **8 distinct ids the browser actually
looked up** (`index__input--email`, `index__button--sign-in`, `settings__textarea--bio`,
…) — not a static guess, the real `page.getByTestId` calls from inside Chromium.

`coverage --runtime` then merged static + runtime:

```
- all tagged ids referenced by tests: 9/27 (33.3%)
- interactive (test-worthy) ids covered: 7/20 (35.0%)
- exercised at run time: 8 registry ids; referenced-but-never-exercised: 1; dynamic ids outside the registry: 0
```

- **exercised = 8** — confirmed against a live DOM, the metric the static report cannot give.
- **referenced-but-never-exercised = 1** — proven to fire, not perpetually 0: a
  `test.skip`'d editor spec references `editorButtonPublishArticle` (static map sees the
  constant) but the browser never looked it up. Exactly the "a test mentions this id but
  never touches it" gap the runtime layer exists to surface.
- The unvisited editor page is the uncovered work list.

## The re-test loop, on real execution

Edited the login button copy `Sign in` → `Log in` (a behaviour change), re-tagged:

```
=== id after the edit (sticky — locator did NOT churn) ===
data-testid="index__button--sign-in"          # frozen
=== affected v1 -> v2 (case-level) ===
| re-test | index__button--sign-in | conduit.spec.ts::sign in with an email shows a status
                                      conduit.spec.ts::empty email is rejected |
```

The id stayed frozen and `affected` named the **exact two test cases** referencing it —
the North Star demonstrated on a running app: an id change is one signal; the change is
flagged and routed to the precise cases, with zero locator churn.

## Fail-closed, on real execution

Removed the editor's Publish button, regenerated constants, type-checked the specs:

```
tests/editor.spec.ts(9,34): error TS2339: Property 'editorButtonPublishArticle'
  does not exist on type '{ ... }'.
```

A removed element is a **compile error**, never a silent runtime miss.

## Real issue surfaced (honest)

The HTML regex adapter tags `<script>` and `<title>` element text — it produced a
grotesque id from the inline `<script>` body and tagged `<title>`. The AST adapters
(Vue/Angular/React) do not do this; the HTML scanner is demo-grade by documented design,
but a real served page is where it shows. These ids land in coverage as
non-interactive/uncovered (no harm to the interactive denominator) but are noise. **Fixed
in this exercise** (TDD): the HTML adapter now skips `script`/`style`/`title`/`head` — a
real served page surfaced what no synthetic fixture had. Re-tag after the fix: 22/44
tagged, no `script--`/`title--` ids, specs still green.

Everything else worked first try: the shipped fixture, the recorder artifact format, the
runtime merge, sticky ids across a real edit, and case-level routing — no code changes
were needed to run the live loop.
