# CI / Automated-Testing Integration

Status: Proposed — 2026-06-11
Relationship: the consumption side of the NORTH STAR (`CLAUDE.md`). Builds on the dual-map
spec (`2026-06-09-sticky-testids-dual-map.md`); turns its library capabilities into a team
pipeline. Implementation increment: CLI exposure (`gen-constants`, `affected`) + `tag --check`.

## 1. Goal

Wire the engine's signals into an automated-testing workflow so that, on every PR:
- removed/renamed ids are caught **at compile time** (fail-closed),
- changed elements (markup **or** referenced symbol definitions) route to the **exact tests
  to re-run**, and only those run in the PR,
- new elements without tests are surfaced,
- and none of this relies on a human reading raw diffs.

## 2. Test-authoring conventions (the contract with test code)

1. **Import generated constants; never hardcode id strings.**
   `page.getByTestId(testIds.loginButtonOnsubmit)` — enables both the compile-time gate and
   precise test-map scanning. The constants module (`testids.generated.ts`) is generated
   from the registry and committed.
2. **Loops use bound per-item ids** (`:data-testid="'user-row-' + u.id"`) and tests locate
   by concatenation. *Honest limit:* dynamic ids are not in the registry, so the test map
   cannot route them — such cases are covered by the periodic full run (see §4).
3. **Weak-signal elements that tests need get a `data-tid`.** The `unstable-identity`
   warning stream is the to-do list; CI may enforce "warning count must not grow".

## 3. CI pipeline stages

| # | Stage | Tool | Gate semantics |
| --- | --- | --- | --- |
| 1 | Tagging check | `testid tag --check` | untagged taggable elements exist → fail; author runs `tag` and commits |
| 2 | Compile gate | `testid gen-constants` → `tsc` over the e2e suite | removed/renamed id ⇒ missing constant ⇒ compile error (forces `retire` handling) |
| 3 | Change routing | `testid affected <from> <to> --tests <dir>` | emits the `write-new` / `retire` / `re-test` report (PR comment artifact) |
| 4 | Selective execution | the `re-test` file list → `npx playwright test <files>` | PR runs only affected tests |
| 5 | Coverage nudge | `write-new` entries with no referencing tests | warn (or block, per team policy) |

`from`/`to` are registry versions: `from` = the version at the merge-base commit, `to` =
the PR head's version (the registry is committed, canonical-JSON, so both are in git).

## 4. The honesty rule: selective execution is an optimization, never a replacement

The L3 boundary (dual-map spec §3.3) means a change to a service/store/shared util that a
handler *calls* is invisible to the registry diff. Therefore:

- **Selective execution applies only when the change set is fully explained by tagged
  component files.** Machine-checkable rule: if the git diff touches files outside the
  tagged-template/component set, CI upgrades to the full suite.
- A **periodic full run** (nightly and/or post-merge on main) remains the constant safety
  net. Direction of error is always over-test, never under-test.

## 5. Registry discipline on branches

Registry versions are linear integers, so two parallel branches both minting `v8` conflict
in git. Convention:
- Feature branches run **`tag --check` only** (no registry writes); or
- if a branch does tag, a conflict is resolved by rebase + re-running `tag` (sticky ids
  guarantee the ids themselves do not change; only version numbering is redone).
- The authoritative registry advance happens on main (post-merge CI runs `tag`).

## 6. Deliverables of this increment (the "1+2" scope)

1. **`testid gen-constants [--out FILE] [--registry DIR | --server URL]`** — emit the
   constants module from the latest snapshot (stdout by default, `--out` writes the file).
2. **`testid affected <fromV> <toV> --tests <dir...> [--out-list FILE]`** — run the diff,
   scan the test sources, print `affectedTestsToMarkdown`; `--out-list` writes the unique
   `re-test` file list (newline-separated) for direct consumption by the test runner.
   Library addition required: the test map must cover ids on **both** sides of the diff
   (removed ids are absent from the `to` snapshot), and must work over either transport —
   so the scanner gains an id-list variant (`buildTestMapForIds(testFiles, ids)`) fed from
   the diff's own id set; `buildTestMap(testFiles, snapshot)` delegates to it.
3. **`testid tag --check`** — CI mode: tags against a throwaway in-memory registry, writes
   nothing (no source rewrites, no registry version), exits non-zero listing files whose
   output would change (i.e. untagged taggable elements exist). Sticky ids make this exact:
   an already-tagged file re-serializes byte-identically.

Out of scope (documented, deferred): per-case (`describe/it`) map granularity (file-level
re-runs are acceptable); dynamic-id routing (§2.2); automatic full-suite upgrade detection
(§4 is a CI-config recipe, not engine code).

## 7. Self-check

- Fail-closed path: §3 stage 2 catches removals at compile time even if a team ignores the
  report from stage 3 — the gates are independent.
- Both transports: every new command goes through `TestIdTransport` (`--server` works);
  `affected` deliberately derives its id set from the diff result so it never needs a
  version-load API that the HTTP transport lacks.
- No new churn: `--check` writes neither files nor registry versions, so feature branches
  can gate without the §5 conflict problem.
