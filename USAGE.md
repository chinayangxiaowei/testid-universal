# Usage Guide

English | [简体中文](./USAGE.zh-CN.md)

Hands-on manual for `testid-universal`. Concepts and principles live in the
[README](./README.md); this document is the step-by-step path plus full references.
Every step in the tutorial has been executed against a real Vue app with a real
Playwright suite (see `docs/findings/`).

---

## 1. Tutorial: from zero to a self-maintaining e2e suite

The walkthrough assumes a Vue 3 project and Playwright; the HTML adapter works the same
way with `--ext .html`.

### 1.1 Install

```bash
npm i -D testid-universal @vue/compiler-sfc   # optional peer, Vue projects only
npm i -D @angular/compiler                    # optional peer, Angular projects only
npm i -D @babel/parser                        # optional peer, React projects only
```

### 1.2 First tagging run

```bash
npx testid tag src --ext .vue --registry .testids
```

- Every taggable element gets a `data-testid` written into the source (commit these edits
  and the `.testids/` directory — both are meant to live in git).
- **Read the warnings.** They are your hygiene to-do list, not noise:
  - `unstable-identity` → the element's id derives from volatile copy; add a `data-tid`
    if tests will target it.
  - `loop-multiplicity` → the element renders N times with one id; bind a per-item id
    (`:data-testid="'row-' + item.id"`). The tagger respects the binding and will never
    mint a static id next to it.
- Re-running is **idempotent and sticky**: tagged files are not rewritten; written ids are
  never recomputed.

### 1.3 Generate constants and write tests

```bash
npx testid gen-constants --registry .testids --out e2e/testids.generated.ts
```

```ts
// e2e/login.spec.ts
import { test, expect } from '@playwright/test';
import { testIds } from './testids.generated';

test('login form interaction', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId(testIds.loginInputEmail).fill('alice@example.com');
  await expect(page.getByTestId(testIds.loginInputEmail)).toHaveValue('alice@example.com');
  await page.getByTestId(testIds.loginButtonOnsubmit).click();
});
```

Rules that make the rest of the loop work:
- **Always import constants; never hardcode id strings.**
- Per-item targeting in loops concatenates the bound id: `getByTestId('row-' + user.id)`
  (these dynamic ids are outside the registry — covered by your periodic full run).
- Commit `testids.generated.ts`. Regenerate it whenever the registry version advances.

### 1.4 The maintenance loop (what happens on every change)

After any code change:

```bash
npx testid tag src --ext .vue --registry .testids        # new version, sticky ids
npx testid affected <prevVersion> <newVersion> --tests e2e --out-list retest.txt --registry .testids
npx playwright test $(cat retest.txt)                    # selective re-run
```

What the report means:

| Action | Trigger | What you do |
| --- | --- | --- |
| `re-test` | markup field changed (`text`, `placeholder`, …) **or** a referenced symbol's definition changed (`symbol:onSubmit`) | run the listed tests; revisit assertions only if they assert the changed thing |
| `retire` | the id is gone | the test no longer compiles anyway (see 1.5); delete or repoint the case |
| `write-new` | a new id appeared, no test references it | write a test (or consciously skip) |

A pure handler-body edit (template untouched) still produces `re-test` with
`symbol:<name>` as the reason — ids stay frozen, behavior changes are not missed.

### 1.5 Fail-closed in practice

When an element is removed (or you force a re-mint), regenerate constants and typecheck:

```bash
npx testid gen-constants --registry .testids --out e2e/testids.generated.ts
npx tsc --noEmit          # e2e/login.spec.ts: TS2339 Property 'loginLinkForgot' does not exist
```

The stale reference is a **compile error**, never a silent runtime miss. Retire the case,
and the suite is green again.

### 1.6 CI gates (recipe)

```bash
npx testid tag src --ext .vue --check      # exit 1 if tagging is needed; writes NOTHING
```

Add a coverage gate so green diffs cannot hide an untested surface: `testid coverage
--tests e2e --min 60` fails CI when the interactive-id coverage drops below the bar
(`tag` also prints per-run tagging stats: how many parsed elements got no id at all).
Wire the five stages (check → constants+tsc → affected → selective run → full-run
fallback) step by step with **[`docs/ci-tutorial.md`](docs/ci-tutorial.md)** (copy-ready
`examples/ci/ci-testid.mjs` + `examples/ci/testid.yml`); rationale in
`docs/superpowers/specs/2026-06-11-ci-integration-design.md`. Two rules to
keep honest: selective execution only when the git diff is confined to tagged component
files; keep a nightly/post-merge full run (changes deeper than one hop past a handler are
invisible to the registry by design — see `dep_defs` in the README).

### 1.7 The coverage-driven loop (validated methodology)

Never write tests by intuition alone — let the tool outputs drive the work, one commit
per signal acted on:

1. **Baseline**: `tag` (read the stats: how much of the parsed surface even has ids),
   `coverage` (the ⚠ table IS your work list), a real run with the recorder +
   `coverage --runtime` (are referenced ids actually exercised? which dynamic ids exist?).
2. **Act on the top ⚠ cluster**: write the spec, re-run, re-measure. Repeat.
3. **Ratchet the gate**: freeze `coverage --min <achieved floor>` in CI so coverage can
   only go up; deferred clusters get logged explicitly, never silently dropped.

Validated end-to-end on a real app (interactive coverage 8.8% → 22.8% in three
worklist-driven commits, `referenced-but-never-exercised` held at 0 throughout) — see
`docs/findings/2026-06-12-coverage-poc-survey.md` and the demo project's
`COVERAGE-LOG.md` for the full trace.

### 1.8 The full testing pyramid (visual / responsive / a11y)

The testid loop is **one layer**: it keeps locators stable and routes re-tests. It does
*not* tell you whether the UI looks right, survives a phone viewport, or is accessible.
A complete frontend setup adds three more layers on the same Playwright run — and they
reuse the very testids this tool generates as their stable anchors:

1. **Visual regression** — Playwright `toHaveScreenshot()` baselines, committed to the
   repo. Snapshot at **two granularities**: full-page (catches layout breakage) AND
   component-scoped via `getByTestId(testIds.x)` (catches localized style changes). The
   generated constants anchor the component shots, so functional and visual tests target
   the same elements.
2. **Responsive** — a `desktop` and a `mobile` Playwright project (`viewport` overrides);
   every functional spec runs on both, so a broken breakpoint fails CI.
3. **Accessibility** — `@axe-core/playwright`, WCAG 2A/2AA, fail on `serious`/`critical`.

```ts
// playwright.config.ts
expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
projects: [
  { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  { name: 'mobile',  use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true } },
],
```
```ts
// visual.spec.ts — layout AND style fidelity
await expect(page).toHaveScreenshot('login.png', { fullPage: true });               // layout
await expect(page.getByTestId(testIds.loginSubmit)).toHaveScreenshot('cta.png');    // style
// a11y.spec.ts
const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
expect(r.violations.filter((v) => ['serious','critical'].includes(v.impact!))).toEqual([]);
```

Two calibration lessons validated while dogfooding this on a real Vue app (Fast Team —
see its `DEV-LOG.md`):

- **A full-page `maxDiffPixelRatio` dilutes localized changes.** A primary-accent colour
  change occupied <2% of the page and slipped under a 0.02 ratio; the **component-scoped**
  shot (the accent is ~96% of *that* image) caught it. Always pair full-page with
  component shots — and the testid is what targets the component.
- **a11y catches what the eye cannot.** axe flagged a low-contrast divider (WCAG AA
  failure) that looked fine in review — automate it, don't eyeball it.

The complementarity is the point: **testid locators are change-*resistant* (a restyle
must not move them — proven: a full redesign kept every id sticky, 0 churn); visual
baselines are change-*sensitive* (a restyle *should* light them up for review).** Both
axes are needed, and they share the same anchors.

### 1.9 The standard testing workflow (ordered + trigger-driven)

§1.1–1.8 describe *capabilities*. This is the **protocol** an agent (or CI) follows on
every change. Two rules govern it: **run gates fast-to-slow so failures surface early,
and let the change TYPE decide which gates are mandatory.** Never call a change done with
a required gate skipped — an id change is *necessary but not sufficient*.

**The pipeline — always this order:**

0. **Baseline.** Note the last-green registry version (`mark-green` anchor / `--since` file).
1. **Static, fast:** `typecheck` → `vitest run --coverage` (unit + code coverage) → lint.
2. **`tag`** (sticky). **Act on every warning before continuing:** `unstable-identity` →
   add a `data-tid`; `loop-multiplicity` / `component-multiplicity` → bind a per-item
   `:data-testid`. (A warning ignored here is a flaky locator later.)
3. **`affected --since` (or `diff`)** → the case-level re-test work list.
4. **`gen-constants --check`** → regenerate + commit if stale; a vanished id must fail
   closed at `tsc`, never silently.
5. **Run the routed tests:** the `affected` e2e specs, **plus** the touched surface's
   **visual regression** (full-page + component) and **a11y**. For any UI change, also
   render and *look* (screenshot) — automated gates don't judge taste.
6. **Coverage:** `coverage --runtime` (testid) + the unit `--coverage` (code). Ratchet
   both gates (`--min` / `coverage.thresholds`); log deferred clusters, never drop silently.
7. **`mark-green`** once the selective suite is green — the new re-test anchor.
8. **CI / nightly:** a **full** run (every spec, all viewports). Code changes deeper than one
   hop past a handler (layer 3+, packages, dynamic dispatch) are invisible to the registry
   *by design*, so the full run is the backstop. `tag` names those dependencies
   (BEYOND tracking depth) and `affected` appends the "⚠ Beyond tracking depth" fallback
   list — when your change touched such code, re-run those tests even if the main table
   is empty.

**The trigger matrix — what each change TYPE must run** (✓ = mandatory):

| You changed… | unit + code cov | tag → affected | functional e2e | visual regression | a11y | full run |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Markup / DOM / attributes | if logic too | ✓ (ids, routing) | affected only | ✓ layout+component | ✓ | — |
| CSS / styling only | — | ✓ (expect **0 churn**) | smoke | ✓ **(the gate for this)** | ✓ (contrast) | — |
| Copy / text only | — | ✓ (`modified{text}`, id frozen) | only if a test asserts the copy | component shot if in a tested el | — | — |
| Handler / validator / logic body | ✓ | ✓ (`symbol:` re-test) | affected (routed by L2) | — | — | — |
| Store / state / data model | ✓ | — | flows touching it | — | — | — |
| New component / screen | ✓ (new) | ✓ (new ids + warnings) | **write new** | **new baselines** | ✓ | — |
| Routing | — | ✓ (route signals) | navigation specs | new routes | — | — |
| Dep bump / build / framework upgrade | ✓ | `tag --check` (expect 0 churn) | — | — | — | ✓ |

Read a row as "the id signal can't see this, so these other gates must": a CSS change
moves no id but must clear **visual + a11y**; a handler-body edit moves no id but
`symbol:` routes its tests; a dependency bump touches nothing the registry sees and so
demands the **full run**. Each row exists because skipping it once let a real defect
through while dogfooding (native-validation bug, WCAG contrast failure, a localized
visual change diluted by a full-page diff) — see the demo project's `DEV-LOG.md`.

---

## 2. CLI reference

All commands accept `--registry DIR` (default `test-artifacts/testids`) or
`--server URL` (remote backend; identical behavior).

| Command | Flags | Notes |
| --- | --- | --- |
| `tag <paths...>` | `--ext .html\|.vue\|.jsx,.tsx[,…]` (default `.html`) · `--adapter html\|vue\|angular\|react` · `--attr NAME` · `--regenerate` · `--dry` · `--check` · `--no-deps` | adapter auto-picked: `.vue` → Vue; `.jsx`/`.tsx` → React (legacy `.js` JSX: pass `--ext .js --adapter react`); `.html` with Angular markers (`(event)=`, `*ngIf`, …) → Angular; else HTML. `--check`: CI gate, writes nothing, exit 1 if tagging needed. `--regenerate`: drop written ids, re-mint from current signals. `--no-deps`: turn off one-hop `dep_defs` tracking (default on; prints its tracked/UNRESOLVED counts) |
| `diff <from> <to>` | — | markdown diff to stdout (field-level + `symbol:` changes) |
| `gen-locators` | `--target robot\|playwright\|cypress\|webdriverio\|selenium-python\|testcafe` (default `robot`) · `--out DIR` (default `tests/locators`) · `--attr` | selector convention `[data-testid="<id>"]` |
| `gen-constants` | `--out FILE` · `--lang ts\|js` (default: from the `--out` extension — `.js/.mjs/.cjs/.jsx` emit plain JS with a JSDoc `@type {const}` instead of `as const`) · `--check` (CI gate: exit 1 if the committed module is missing/stale vs the latest registry) (default stdout) | throws on constant-name collision (fail-closed guarantee) |
| `mark-green` | `--since FILE` (default `.testids-green.json`) | records the latest registry version as the re-test anchor; run it after the selective suite passes. `affected --since FILE` then always diffs last-green -> latest |
| `rollback` | (embedded only) | repoints `latest` to the prior version (non-destructive: the rolled-back `v<N>.json` is kept, a re-tag overwrites it). Use after a bad tag run |
| `activity` | (embedded only) | prints the registry activity log (every save + rollback, oldest first) |
| `coverage` | `--tests DIR[,DIR]` (default `e2e`) · `--min N` · `--runtime FILE` | coverage of tagged ids by tests (overall + interactive); `--min` gates on the interactive percentage (exit 1 below); `--runtime` merges an exercised-ids artifact (referenced vs exercised + dynamic ids) |
| `affected <from> <to>` (or `--since FILE`) | `--tests DIR[,DIR]` · `--out-list FILE` (file list for the runner) · `--include-limited` (add the beyond-depth fallback tests to that list) · `--grep-out FILE` (test-title alternation for `-g`/`-t`) · `--files-only` (legacy file-level report) | case-level by default: names the exact `test(...)` block each changed id sits in `--tests DIR[,DIR]` (default `e2e`) · `--out-list FILE` | scans `.ts/.tsx/.js/.jsx/.mjs/.cjs`; the generated constants file is auto-excluded; `--out-list` = newline-separated `re-test` files |

Backend: `npm run serve` boots the REST shell (`PORT`, `REGISTRY_DIR` env vars). Without
`DATABASE_URL` it uses `JsonFileStorage` and warns at startup that this is safe for one host
only; set `DATABASE_URL` (and `npm install pg`) to use `PostgresStorage` for multi-host writers.

## 3. Configuration reference (`CoreConfig`)

The CLI exposes `--attr` only; full config goes through the library
(`runPipeline(adapter, transport, files, config)`) or the service.

| Field | Default | Meaning |
| --- | --- | --- |
| `idFormat` | `{component}__{element}--{key}{disambiguator:--}` | tokens: `{component}` `{element}` `{key}` `{tag}` `{disambiguator}`; the `:--` form renders `--<value>` only when present |
| `attributeName` | `data-testid` | the attribute written/read |
| `explicitKeyAttribute` | `data-tid` | the author-written stable key (Tier 0); wins the identity outright |
| `customTagMap` | `{}` | component-library classification, e.g. `{ 'v-btn': { short: 'button', long: 'vuetify_btn' } }` (see `VUETIFY_TAG_MAP`) |
| `ignoreTags` | `[]` | never tagged, period |
| `skipTags` | `h1…h6, th, label, option, optgroup` | not minted **unless** they carry a `data-tid` or an already-written id (sticky always honored). `option`/`optgroup`: native selects are driven by the parent's value, so options are not auto-minted — but a `data-tid` opts one in, and custom `role="option"` items (`<li>`/`<div>`, the kind you click) are unaffected. |

Identity-key priority (core-owned, not configurable):
`explicit_key → form_control → name → route → event_handlers → bound_identifiers →
html_id → structural → child_shape → text → aria_label → placeholder → tag`.

## 4. Warnings reference

The CLI prints each warning as `[<code>] <message>`; programmatically the field is
`Warning.code` (filter CI logs or `result.warnings` on it).

**Anchor drift (diff/affected, not a tag warning).** When a sticky id stays but the element
it sits on now has a different identity (e.g. `onClick={submit}` → `onClick={other}`, or the
tag changed), `diff` marks the entry `anchor_drift` with an `identity` change and a
"⚠ Anchor drift" section; `affected` labels the row `re-test ⚠ anchor drift`. Re-check what
the test asserts, not just whether it passes; consider `tag --regenerate` or a `data-tid`.

| Code | Trigger | What to do |
| --- | --- | --- |
| `unstable-identity` | a freshly-minted id's key fell through to copy (`text`/`aria_label`/`placeholder`) or the bare tag | add a `data-tid` if tests will target it; otherwise ignorable (the id is sticky once written) |
| `loop-multiplicity` | element is inside `v-for`/`*ngFor` — one static id, N rendered instances | bind a per-item id (`:data-testid="'x-' + item.id"`); the tagger then skips it entirely |
| `positional-disambiguator` | same-identity siblings with no distinguishing stable token; slots assigned positionally (registry-stable, but reorder-sensitive for *identical* elements) | give one of them an explicit `data-tid` |
| `component-multiplicity` | a component whose file contains tagged elements is instantiated >= 2 times across the run (`<ArticlePreview>` x N, `app-list-errors` x N, ...) — every id inside it appears N times in the DOM (the cross-file sibling of `loop-multiplicity`) | scope queries to an instance container, or bind per-instance ids inside the component; components with no internal ids stay silent (no duplicates arise) |

## 5. Registry files

`--registry` directory contents (commit it):

- `v<N>.json` — one immutable snapshot per tag run; `latest.json` — copy of the newest.
  Written as **canonical JSON** (sorted keys) so git diffs show only real changes.
- Snapshot: `{ version, generated_at, entries, retired }`.
  - `entries[id]`: `component`, `tag`, `element_type`, `identity` (stable matching key),
    `fingerprint` (descriptive), `disambiguator`, `symbol_defs` (referenced-symbol
    definition hashes), `signals` (normalized snapshot), `source`
    (`generated` | `sticky` | `manual`), `first_seen_version`, `last_seen_version`,
    `last_generated_at`, `generation_history`.
  - `retired`: tombstones for ids no longer present — provenance survives an id
    disappearing and returning (drives `regenerated` classification).

## 6. FAQ & troubleshooting

**Copy changed but the id didn't — bug?**
No: that is the core guarantee. The diff reports `modified { text }`; the locator keeps
working. Re-test only if the test asserts that copy.

**I *want* a fresh id.**
Delete the attribute (that element re-mints next run) or `tag --regenerate` (everything
re-mints). Caveat: a signal-less element that was taggable only via its legacy id is
skipped after `--regenerate` and keeps a stale attribute — give such elements a `data-tid`
first (documented limitation).

**`data-tid` vs `data-testid`?**
`data-tid` is the *input*: a hand-written stable key that wins identity. `data-testid` is
the *output* the tool writes and tests query. They coexist on the same element.

**A `th`/`label`/heading/`option` I actually want tagged is skipped.**
`skipTags` skips those tags for fresh *minting* only. Add a `data-tid` to that element to
opt it back in (the skip is soft), or shrink `skipTags` via config. `option`/`optgroup`
are skipped because native selects are targeted by the parent's value, not per-option —
custom `role="option"` widgets (`<li>`/`<div>`) are never affected.

**Per-row buttons in a table all share one id.**
That is the `loop-multiplicity` warning. Bind a per-item id; until then only count-level
assertions are reliable (`expect(getByTestId(...)).toHaveCount(n)`).

**`gen-constants` throws "collides".**
Two ids reduce to the same camelCase constant. Give one element an explicit `data-tid`.
The throw is deliberate — a silent duplicate key would make the fail-closed gate fail open.

**Registry conflicts when two branches both tagged.**
Feature branches should run `tag --check` only; advance the registry on main (post-merge
CI). If a branch did tag: rebase and re-run `tag` — sticky ids guarantee the ids
themselves do not change, only version numbering is redone.

**Symbol tracking didn't flag my change.**
Covered: the definitions an element references directly (`symbol:` — handler names, bound
roots, `v-model` targets) plus ONE hop further (`dep:` — same-file helpers, imported
functions through relative paths / tsconfig `paths` / barrels, hook & store members via an
instance alias, Angular injected service methods). Check, in order: (1) `tag` printed
`dep tracking: OFF` (you passed `--no-deps`) or an UNRESOLVED import — that import's
changes cannot trigger; fix the alias in tsconfig `paths`; (2) the changed code is a
third hop (what the service itself calls), a bare package, or dynamic dispatch — not
tracked by design (layer 3 and dynamic dispatch are listed by `tag` as BEYOND tracking
depth and in `affected`'s fallback section); (3) the dependent file was not in the `tag` run (cross-file changes are
seen only when the page that uses them is re-parsed — tag the whole tree); (4) options API
/ plain `<script>` (Vue) resolve nothing. That is why the periodic full run exists.

**A shared hook/store change re-tests many cases.**
Expected: `dep_defs` slices the accessed *member* (`tasks.claimTask`), but an element bound
to the store object itself (`v-model="tasks.query"`, whose root is `tasks`) depends on the
whole store definition, and every element using a changed shared helper is genuinely
affected. Over-flagging is the safe direction; `tag --no-deps` restores first-hop-only
tracking (toggling it is noise-free).

**`tag` on `.vue` errors about `@vue/compiler-sfc`.**
Install the optional peer: `npm i -D @vue/compiler-sfc`.

**What coverage percentage is "the standard"?**
There is no universal one. Mandated numbers exist only in safety-critical UNIT-coverage
standards (DO-178C: 100% MC/DC for level A; ISO 26262 tiers); for ordinary code coverage
the industry folklore is an 80% CI gate (Google's tiers: 60% acceptable / 75%
commendable / 90% exemplary — with the caveat that coverage only tells you what is
definitely UNtested). For the interactive e2e coverage this tool reports there is NO
industry baseline at all. Use it the validated way instead of chasing a number:
(1) critical user journeys (login, payment, core CRUD) → every interactive element
referenced, defined by business path, not percentage; (2) the long tail → measure the
baseline, act on the biggest ⚠ cluster, then ratchet: set `--min` to the new measured
value so it can only go up; (3) trust the denominator before the ratio — a fix that
makes the denominator more honest will LOWER the percentage (here: 59.6% → 54.7% when
wired-but-unnamed components started counting), and that is progress, not regression.
Recalibrate `--min` after upgrading, don't revert.

**I tagged a subdirectory and feared everything else got retired.**
It does not (since the scoped-reconcile fix): an absent id is retired only when its
recorded source file was actually parsed in that run; entries from files outside the run
are carried forward untouched, and the CLI prints how many. One caveat: registries
written before this fix have no file scope recorded — run ONE full tag to upgrade them,
then partial runs are safe.
