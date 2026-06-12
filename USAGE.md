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
fallback) per `docs/superpowers/specs/2026-06-11-ci-integration-design.md`. Two rules to
keep honest: selective execution only when the git diff is confined to tagged component
files; keep a nightly/post-merge full run (transitive code changes are invisible to the
registry by design).

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

---

## 2. CLI reference

All commands accept `--registry DIR` (default `test-artifacts/testids`) or
`--server URL` (remote backend; identical behavior).

| Command | Flags | Notes |
| --- | --- | --- |
| `tag <paths...>` | `--ext .html\|.vue\|.jsx,.tsx[,…]` (default `.html`) · `--adapter html\|vue\|angular\|react` · `--attr NAME` · `--regenerate` · `--dry` · `--check` | adapter auto-picked: `.vue` → Vue; `.jsx`/`.tsx` → React (legacy `.js` JSX: pass `--ext .js --adapter react`); `.html` with Angular markers (`(event)=`, `*ngIf`, …) → Angular; else HTML. `--check`: CI gate, writes nothing, exit 1 if tagging needed. `--regenerate`: drop written ids, re-mint from current signals |
| `diff <from> <to>` | — | markdown diff to stdout (field-level + `symbol:` changes) |
| `gen-locators` | `--target robot\|playwright\|cypress\|webdriverio\|selenium-python\|testcafe` (default `robot`) · `--out DIR` (default `tests/locators`) · `--attr` | selector convention `[data-testid="<id>"]` |
| `gen-constants` | `--out FILE` · `--check` (CI gate: exit 1 if the committed module is missing/stale vs the latest registry) (default stdout) | throws on constant-name collision (fail-closed guarantee) |
| `mark-green` | `--since FILE` (default `.testids-green.json`) | records the latest registry version as the re-test anchor; run it after the selective suite passes. `affected --since FILE` then always diffs last-green -> latest |
| `coverage` | `--tests DIR[,DIR]` (default `e2e`) · `--min N` · `--runtime FILE` | coverage of tagged ids by tests (overall + interactive); `--min` gates on the interactive percentage (exit 1 below); `--runtime` merges an exercised-ids artifact (referenced vs exercised + dynamic ids) |
| `affected <from> <to>` (or `--since FILE`) | `--tests DIR[,DIR]` (default `e2e`) · `--out-list FILE` | scans `.ts/.tsx/.js/.jsx/.mjs/.cjs`; the generated constants file is auto-excluded; `--out-list` = newline-separated `re-test` files |

Backend: `npm run serve` boots the REST shell (`PORT`, `REGISTRY_DIR` env vars).

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
| `skipTags` | `h1…h6, th, label` | copy-only tags: not minted **unless** they carry a `data-tid` or an already-written id (sticky always honored) |

Identity-key priority (core-owned, not configurable):
`explicit_key → form_control → name → route → event_handlers → bound_identifiers →
html_id → structural → child_shape → text → aria_label → placeholder → tag`.

## 4. Warnings reference

| Code | Trigger | What to do |
| --- | --- | --- |
| `unstable-identity` | a freshly-minted id's key fell through to copy (`text`/`aria_label`/`placeholder`) or the bare tag | add a `data-tid` if tests will target it; otherwise ignorable (the id is sticky once written) |
| `loop-multiplicity` | element is inside `v-for`/`*ngFor` — one static id, N rendered instances | bind a per-item id (`:data-testid="'x-' + item.id"`); the tagger then skips it entirely |
| `positional-disambiguator` | same-identity siblings with no distinguishing stable token; slots assigned positionally (registry-stable, but reorder-sensitive for *identical* elements) | give one of them an explicit `data-tid` |

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

**A `th`/`label`/heading I actually want tagged is skipped.**
`skipTags` skips copy-only tags for fresh minting. Add a `data-tid` to that element (or
shrink `skipTags` via library config).

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
Covered: Vue `<script setup>` top-level declarations directly referenced by the element
(handler names, bound roots, `v-model` targets). Not covered (by design): transitive
calls (service/util bodies), options API / plain `<script>`, imports beyond their import
statement. That is why the periodic full run exists.

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
