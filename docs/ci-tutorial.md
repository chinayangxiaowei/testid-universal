# CI tutorial: wiring testid-universal into automated tests

> The **operational** guide (zero to a working pipeline). Design rationale lives in
> `docs/superpowers/specs/2026-06-11-ci-integration-design.md`; recipes and the agent
> protocol in `USAGE.md` §1.6 / §1.9. Adapted from a downstream adopter's field-tested
> write-up (a React 18 + Vite + Vitest project); every scenario in §7 was re-run on the
> `fast-team` Vue venue.
>
> Ready-to-copy files: [`examples/ci/ci-testid.mjs`](../examples/ci/ci-testid.mjs) (the
> router) and [`examples/ci/testid.yml`](../examples/ci/testid.yml) (GitHub Actions shell).

## 0. What this pipeline does

After every change, compute **exactly which e2e tests must run** — instead of running
everything blindly or nothing blindly.

- An element removed / renamed → its generated constant disappears → **compile error**
  (fail-closed; nobody has to read a diff).
- A handler body, or a definition it directly uses (one hop: helper, imported function,
  store/hook member, injected service method), changed → routed to the **exact test cases**.
- Code beyond that (layer 3+, dynamic dispatch) → **named** as a fallback, never reported
  as "nothing to re-test".
- Anything the router cannot vouch for → the **full suite**. Selective execution is an
  optimization, never a replacement.

## 1. Prerequisites: a committed registry and constants

CI is not the starting point; get the local loop working first (`USAGE.md` §1.1–1.5):

```bash
npx testid tag src --ext .vue --registry .testids             # ids + registry
npx testid gen-constants --registry .testids --out e2e/testids.generated.ts
```

Three rules:

1. Tests import `testIds` from the generated module — **no hard-coded id strings** (a
   removed id must fail at compile time).
2. **Commit the registry (`.testids/`) and the constants module.** The CI baseline is the
   registry version committed at the merge-base.
3. **After upgrading testid-universal, run `tag` once and commit the registry.** New
   signals (e.g. one-hop `dep_defs`) are compared only when the baseline has them too —
   that is what makes upgrades noise-free, and it also means a stale baseline cannot
   route them. Verified: with a pre-upgrade baseline, a store-action edit routed nothing;
   after committing one `tag` run, the same edit routed the two exact claim cases.

`--out` decides the constants flavor: `.js/.mjs/.cjs/.jsx` emit plain JS (JSDoc
`@type {const}`), `.ts` emits `as const` (`--lang ts|js` overrides).

## 2. The five stages

| Stage | Tool | Gate |
| --- | --- | --- |
| ① tagging gate | `testid tag … --check` | untagged element → exit 1; writes nothing |
| ② constants gate | `gen-constants --check` + `tsc` | stale module → exit 1; removed id → compile error |
| ③ route | `scripts/ci-testid.mjs` (or `testid affected`) | `mode=selective\|full\|none` + `retest.txt` |
| ④ selective run | runner fed by `retest.txt` | only when `mode=selective` |
| ⑤ full run | post-merge + nightly | the backstop for everything ③ cannot see |

### 2.1 ① Tagging gate

```bash
npx testid tag src --ext .vue --registry .testids --check
```

In-memory registry, no file writes; an already-tagged tree re-serializes byte-identically
→ exit 0. A PR that adds an element without running `tag` fails here.

### 2.2 ② Constants fail-closed

```bash
npx testid gen-constants --registry .testids --out e2e/testids.generated.ts --check
npx tsc --noEmit      # or your build: a removed id's constant is gone -> the test fails to compile
```

### 2.3 ③ Route

**Recommended: the reference script, merge-base mode.**

```bash
node scripts/ci-testid.mjs --src src --ext .vue --registry .testids --tests e2e --base origin/main
```

What it does, without ever writing your sources or the committed registry:

1. copies `.testids/` to a temp dir and tags the current sources into that copy → `to`;
2. `from` = the registry version committed at `git merge-base origin/main HEAD`;
3. diffs `from → to` and routes it to test cases (anchor drift and UNRESOLVED imports are
   called out in the report);
4. **honesty rule** — if the git diff touches source files outside the tagged set, it
   switches to `mode=full` (see §3);
5. adds the **beyond-depth fallback** tests only where untracked code may have changed
   (the element's own file changed, or untagged code changed under `--trust-deps`);
6. writes `retest.txt`, `testid-report.md`, and `mode=…` (also to `$GITHUB_OUTPUT` and
   the job summary).

Exit codes: 0 routed, 1 sources need tagging / no registry, 2 usage error. Options:
`--since FILE` (green-anchor mode instead of `--base`), `--adapter`, `--trust-deps`,
`--no-limited`, `--full`.

Because `to` is computed from the PR's sources in CI, the PR does **not** need to commit a
registry advance to be routed correctly — only the ids `tag --check` demands.

**Alternative: CLI only (green-anchor mode).** No script, no git logic:

```bash
npx testid mark-green --registry .testids --since .testids-green.json   # after a green run
npx testid tag src --ext .vue --registry .testids                         # after a change
npx testid affected --since .testids-green.json --tests e2e --registry .testids \
  --out-list retest.txt --include-limited
```

`--out-list` writes only `re-test` files; `--include-limited` adds every beyond-depth
fallback test (the CLI has no git diff to narrow it). The CLI does **not** apply the
"outside the tagged set" rule — your CI must (§3). Commit `.testids-green.json` if CI
relies on it; an uncommitted anchor dies with the runner.

### 2.4 ④ Selective run — guard the empty list

```bash
npx playwright test $(cat retest.txt)    # DANGER if retest.txt is empty
```

With an empty list, `playwright test` / `vitest run` receive no filter and run **the
whole suite**. Safe, but it silently defeats routing and hides a "nothing affected"
answer. Branch on the mode instead (the workflow does):

```bash
case "$MODE" in
  selective) npx playwright test $(cat retest.txt) ;;
  full)      npx playwright test ;;
  none)      echo "no test affected" ;;
esac
```

### 2.5 ⑤ Full run

Post-merge on main and nightly, always. It catches what routing cannot see by design:
layer 3+, bare packages, dynamic dispatch, files outside the `tag` run, environment drift.

## 3. Honesty rules (do not skip)

Dependency tracking stops one hop past a handler. Two machine-checkable rules keep the
selective run honest (spec §4):

1. **The git diff touches source files outside the tagged set → full suite.** The engine
   does not implement this — your CI does; the reference script does it by default.
2. **Untracked dependencies that may have changed → run their tests.** `tag` prints them
   as "BEYOND tracking depth", the registry keeps them as `dep_limited`, and `affected`
   appends a "⚠ Beyond tracking depth" section, e.g.
   `| taskdetailview__button--detail-claim | claim>tasks.claimTask>this.persist | task-detail.spec.ts |`.

`--trust-deps` relaxes rule 1: an untagged change (a store, a service) is routed through
one-hop `dep_defs` plus **all** beyond-depth fallback tests instead of the full suite.
Use it once the fallback list is small relative to your suite; on a small app it
converges on the full suite anyway. Direction of error is always over-test.

## 4. Registry discipline on branches

Registry versions are linear integers; two branches that both mint `v8` conflict in git.

- PRs run `tag --check` in CI (no writes). Run `tag` locally only when it is required
  (new elements), and commit ids + registry together.
- On a version conflict: rebase and re-run `tag` (sticky ids keep the ids; only version
  numbers are redone).
- Advance the authoritative registry on main after merge (optional step in
  `examples/ci/testid.yml`, needs `contents: write`). Skipping it is safe: a stale
  baseline re-reports earlier merged changes (over-routing), it never misses a PR's own.
- Concurrency: `JsonFileStorage` is safe for parallel processes on one host (lock file +
  atomic writes + compare-and-swap); a shared multi-host service uses `PostgresStorage`
  (`serve` picks it up from `DATABASE_URL`).

## 5. GitHub Actions

Copy [`examples/ci/testid.yml`](../examples/ci/testid.yml) to `.github/workflows/` and
`examples/ci/ci-testid.mjs` to `scripts/`, then adjust the `env:` block (`SRC`, `EXT`,
`TESTS`, `CONSTANTS`) and the test command. Its shape:

- `selective` (pull_request): checkout with `fetch-depth: 0` → ① → ② → ③ route (`id:
  route`) → ④ branches on `steps.route.outputs.mode`.
- `full` (push to main + nightly cron): gate + full suite (+ the optional registry advance).

GitLab / CircleCI / a pre-push hook: same script, different trigger.

## 6. Library route (custom routers)

Everything the script uses is public API from `testid-universal`: the adapters,
`LocalTransport`, `JsonFileStorage`, `runPipeline`, `affectedTestCases`,
`buildTestCaseMapForIds`, `depthLimitedTests`, `retestFiles`. Note: transports expose
`latest()` / `diff()` only; `loadVersion()` lives on the storage. `affected` builds its map
from the diff's own id set (`buildTestMapForIds`), so it also works over `HttpTransport`.

## 7. Verified scenarios (fast-team, reference script, `--base main`)

| Change | Result |
| --- | --- |
| nothing | `mode=none` |
| `claim()` handler body in `TaskDetailView.vue` | `selective`: `task-detail.spec.ts` only |
| store action `claimTask` (untagged file) | `full` (honesty rule) |
| same, `--trust-deps --no-limited` | `selective`: both claim cases + `search filters the board` (that input binds the whole store — a documented over-flag) |
| layer-3 `persist()`, `--trust-deps` | fallback tests added |
| new untagged `<button>` | exit 1: "1 file(s) need tagging" |

In every run the working tree stayed clean.

## 8. Acceptance checklist

- [ ] `tag --check` exits 0 on the tagged repo, 1 after adding an untagged element.
- [ ] `gen-constants --check` exits 1 when stale; removing an id breaks `tsc`.
- [ ] A handler-body edit routes to its cases (`testid diff` shows `symbol:<name>`).
- [ ] A one-hop edit shows `dep:<handler>><ref>` in `testid diff` (after the baseline in §1).
- [ ] A layer-3 edit produces no diff entry, but its tests appear in the fallback section.
- [ ] A sticky id whose element changed identity is reported as anchor drift.
- [ ] An empty `retest.txt` does not trigger an accidental full run (mode branching).
- [ ] Post-merge and nightly full runs are green.

## 9. References

- Design: `docs/superpowers/specs/2026-06-11-ci-integration-design.md`
- One-hop tracking: `docs/superpowers/specs/2026-11-17-one-hop-dep-tracking.md`
- Recipes / agent protocol: `USAGE.md` §1.6, §1.9
