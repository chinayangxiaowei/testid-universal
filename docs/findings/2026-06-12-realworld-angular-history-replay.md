# Real-history replay: angular-realworld-example-app vs TestID-Generator

**Venue.** `gothinkster/angular-realworld-example-app` (clone at container
`real-conduit-ng/`, 261 commits, 10 component templates, ~184–215 elements). Unlike the
hand-scripted `sim-angular-app` stream, every event here is a REAL upstream commit.

**Method.** Base = `02b8d88^` (modern era: standalone components, `@if`/`@for` control
flow, reactive forms). Each tool gets its own branch (`sim-ours` / `sim-orig`): S0 tags
the base (committed), then 8 real commits are replayed with `git merge -X theirs
--no-edit <commit>` — upstream wins on conflicting lines, so testid attributes on edited
lines are physically LOST (realistic adoption noise) — followed by re-tag + registry
diff. Scripts: `/tmp/ng2-ours.sh`, `/tmp/ng2-orig.sh`; logs `/tmp/ng2-*`. Both scripts
assert branch + clean tree before running (lesson from the cmp-ours contamination).

The 8 events: `02b8d88` URL pagination · `51c4afd` **rewrote with signals** (`x` →
`x()` in 6 templates + 6 companion `.ts`) · `857a75e` navbar auth state · `5467760`
error management · `85431f0` nullable images/bio (adds `| defaultImage` pipe) ·
`fe77d9c` e2e framework agnosticism (adds `name` attrs) · `ae1d441` new logo ·
`06ecc35` homepage message (pure copy).

## Results

Ours (u/a/r/m = unchanged/added/removed/modified):

| Step | u | a | r | m | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| S0 | — | — | — | — | 76/184 tagged (103 no-signal, 5 policy-skipped), 11 unstable-identity, loop warns on `@for` subtrees |
| S1 pagination | 72 | 4 | 4 | 0 | `setListTo` handler removed from links → identity honestly changed (wiring changed = re-test) |
| S2 signals | 68 | 3 | 3 | **5** | **3 of 5 are `symbol:*`-triggered** (companion `.ts` rewrite caught by L2 with ids and markup frozen); 2 `bound_identifiers`; add/remove are genuine structural renames |
| S3 navbar | 76 | 6 | 0 | 0 | new `@if` branches add elements; nothing churns |
| S4 errors | 71 | 7 | 4 | 7 | includes `symbol:profile` triggers |
| S5 nullable img | 85 | 0 | 0 | **0 → 3 after fix** | see "Found gap" below |
| S6 e2e names | 74 | 0 | 0 | 11 | all `name` field — ids held (formControlName outranks name) |
| S7 logo | 83 | 0 | 0 | 2 | brand link `text` — copy noise contained at fingerprint level |
| S8 home copy | 83 | 3 | 2 | 0 | copy-keyed elements churn on copy edits — exactly what their `unstable-identity` warning predicted (slugs are also unboundedly long; cosmetic) |

Original tool (with `renamed` = fuzzy 0.8 match):

| Step | u | a | r | renamed | m | Collisions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| S0 | — | — | — | — | — | 182 entries, **75 unresolvable duplicate ids** |
| S1 | 175 | 3 | 3 | 1 | 3 | 76 |
| S2 | 104 | 14 | 14 | 0 | **64** | 76 |
| S3 | 162 | 20 | 3 | **10** | 7 | 95 |
| S4 | 182 | 17 | 8 | 2 | 7 | 101 |
| S5 | 204 | 1 | 3 | 0 | 1 | 101 |
| S6 | 197 | 0 | 0 | 0 | 11 | 101 |
| S7 | 205 | 2 | 0 | 0 | 3 | 101 |
| S8 | 206 | 6 | 3 | 0 | 1 | 101 |

## Headlines

1. **S2 (signals rewrite) is the decisive step.** The original reports 64 modified +
   14/14 added/removed out of 182 — `article` → `article()` leaks into every
   `struct.@if=` fingerprint fragment, burying the real change. Ours reports 5, of
   which 3 carry `symbol:<name>` — the **first real-project proof of the L2 map**: the
   component class was rewritten, ids and markup stayed frozen, and exactly the
   elements wired to the rewritten members got a re-test trigger via companion-`.ts`
   hashing. The original cannot see `.ts` at all.
2. **Precision guarantee.** The original carries 75→101 *unresolvable duplicate ids*
   through the whole run, each re-tag printing "surviving mapping is heuristic". Ours
   never emits a duplicate (uniqueness invariant); ambiguity surfaces as warned
   positional groups instead.
3. **Resilience to physical tag loss.** The `-X theirs` merges deleted 5–13 written
   attributes per step. Deterministic identity re-minted byte-identical ids every
   time — S5: registry 85/85 unchanged despite 5 lost tags. The original instead shows
   churn (S3: renamed=10, added=20 on a navbar refactor).
4. **Parity where fingerprints suffice.** S6 (added `name` attrs): both tools report
   the same 11 field-level modifieds; ids held on both sides.
5. **Surface honesty.** Original tags 182/182 elements (hence the collisions); ours
   tags 76/184 and *accounts for the rest* (103 no-signal + 5 policy-skipped) via the
   coverage denominator — the work list, not silence.

## Found gap (fixed during this replay)

S5 changed `[src]="p.image"` → `"p.image | defaultImage"` — rendering behavior changed,
but we reported **0 modified** (the original caught 1): identity normalization keeps
only the root identifier, and no adapter fed raw expression text anywhere. Fix
(`c2cbc16`, `2422ad7` in main): both real adapters now write raw binding/handler
expressions into the `static_attributes` catch-all — which by contract feeds the
fingerprint ONLY — and `diff` attributes each changed key as `attr:<key>`. Replayed
S4→S5 with the fix: exactly 3 modified, all `attr:[src]`, ids untouched.

Honest residuals: pipe names are not tracked as L2 symbols (a `defaultImage`
implementation edit still goes unseen — same class as the L3 transitive boundary;
recorded, not built). Registries written before this fix will flag a one-time
`attr:*` wave on their first re-tag — over-flag is the safe direction.
