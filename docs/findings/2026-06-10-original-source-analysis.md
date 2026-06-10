# Findings — Deep source analysis of the original TestID-Generator (2026-06-10)

Method: full clone at container root (`TestID-Generator/`, sibling of `main/`); three parallel
deep reads (tagger / registry+differ+rollback / locators+migrate), every claim cited to
file:line in the original; one claim cross-verified by executing our own tool. Purpose:
(1) confirm what the original does NOT do (validates our roadmap), (2) harvest what it does
better (adoption candidates), (3) ground Phase D's design risk in evidence.

## 1. Confirmed ABSENCES in the original — our roadmap is real, not reinvention

1. **It never reads TypeScript.** All symbol extraction (`getBoundIdentifiers`
   `template-parser.ts:657`, `getEventHandlerNames` `:683`, `getInterpolationData` `:718`)
   walks the *template expression AST only* and returns name/path strings
   (`saveOrder`, `order.customer.name`). No component-class lookup, no definition
   resolution, no file hashing. The registry schema (`registry/schema.ts:95-127`) has **no
   source-dependency or symbol-hash field of any kind**.
   → Our Phase D (definition-level hashes) is a genuine capability gap, not duplication.
2. **No testID → test-case map and no fail-closed mechanism.** `migrate-locators` is pure
   string rewriting of `${VAR}` in `.robot` files keyed by testid (`migrate/plan.ts:47-80`,
   `applier.ts:16-98`). A removed id whose variable is still referenced is only a textual
   "STILL REFERENCED" warning — **exit code stays 0 (fail-open)** (`migrate/report.ts`).
   → Our Phase C (generated constants → compile-time failure + affected-tests routing) is a
   real advance over the original.
3. **No field-level modified diff.** Its diff shows old/new fingerprint strings whole
   (`report-generator.ts`); ours reports exactly which fields changed.
4. **No tombstones.** Removed ids are dropped from the registry; history is *re-derived
   every run by scanning all `testids.vN.json` on disk* (`history.ts:31`,
   O(versions × entries), and pruned versions silently lose history). Our `retired`
   tombstones are structurally cheaper and survive retention.

## 2. CONFIRMED BUG in our Vue adapter — bound `:data-testid` is fought, not respected

Reproduced against our built `main` (2026-06-10): an element carrying
`:data-testid="'user-row-' + u.id"` — **the exact fix our own loop-multiplicity warning
recommends** — gets a *second, static* `data-testid` written next to the binding:

```html
<li v-for="u in users" :key="u.id" :data-testid="'user-row-' + u.id" data-testid="list__li--user-row-u-id">
```

Both attributes now coexist (a Vue conflict; the tool actively undoes the developer's
correct per-item fix, and the bound *expression text* even leaks into the minted key).
The original explicitly skips elements with a bound testid — no fingerprint, no registry
entry, no warning (`tagger.ts:525-527`).

**Fix:** in `VueAdapter.parse`, if `bound['data-testid']` (or the configured attribute)
exists, skip the element entirely (or set `existingId` to a sentinel that suppresses
minting and the loop warning). High priority — it breaks the documented loop remedy.

## 3. SUSPECTED BUG in our constants generator — leading-digit identifiers

The original's Robot variable namer prefixes `tid` when the camelized name starts with a
digit (`locators/render.ts:11-23`). Our `camelName` has no such guard: an id starting with
a digit (e.g. component file `1page.vue`) would make `generateConstants` emit
`{ 1pageInputX: '...' }` — **syntactically invalid TypeScript**. Unverified by test; needs
a regression test + the same prefix guard.

## 4. Adoption candidates from the original (prioritized)

1. **Registry-stable sibling-index assignment** (`tagger.ts:1132-1215`) — the capability we
   deferred from spec §4.4, and it turns out implementable: a 3-phase slot assignment:
   (1) candidates already carrying `--N` in source lock that suffix; (2) remaining
   candidates inherit the lowest previous-registry slot whose **fingerprint matches
   byte-exact** (no similarity); (3) rest take next free integer. Note: our Phase A sticky
   already subsumes phase 1 (written ids freeze); the incremental value is phase 2 —
   first-mint slot inheritance for not-yet-written elements. Smaller gap than we thought.
2. **Bound-testid skip** — see §2; adopt immediately.
3. **Context anchors** (`resolveContextAnchors` `template-parser.ts:756-841`): label_for /
   wrapper_label / fieldset_legend / preceding_heading / aria_labelledby_text, with
   section-boundary-capped upward walks and full-tree DFS for `for=`/`aria-labelledby`
   joins. We have the `context` slot but no adapter fills it. Note the cost it showed in
   our Angular experiment: one heading edit rippled `modified` into 7 siblings —
   if adopted, context should likely be **fingerprint-only AND excluded from the
   re-test trigger's default field set**, or made opt-in.
4. **Safety nets** (maps to HANDOFF P5): `backup.v{N}` + one-level `rollback`
   (`rollback.ts:28-68`), `registryRetention` pruning (`writer.ts:149-157`), per-run
   activity log with disposition kinds new/regenerated/carried-over/manual-override
   (`activity-log.ts:14-22`), and a `collisions.v{N}.json` diagnostic dump grouping
   unresolved collisions by fingerprint with a full semantic snapshot per group.
5. **Canonical JSON registry writes** (`writer.ts:78`): keys sorted at every level → files
   byte-identical for identical content; good for VCS diffs. Cheap to adopt.
6. **Cross-file constant collision detection** (`locators/generator.ts:122-141`): two
   modules exporting the same variable name silently shadow each other in Robot imports;
   it detects and warns. Our `generateConstants` throw-on-collision covers the single-file
   case; a multi-module future should remember this.
7. **Locator-name locking** (`lockNames`, `generator.ts:164-180`, frozen-first
   disambiguation `generator.ts:301-343`; rename-aware `locator_name` transplant via 0.8
   similarity in `registry/merge.ts:95-133`): sticky-ids applied to *variable names*.
   Our constants derive mechanically from the id (and ids are sticky), so we get most of
   this for free — but the "frozen-first, newcomers take later slots" idea applies if we
   ever disambiguate constant names instead of throwing.
8. **Version-tolerant AST type guards** (`template-parser.ts:317-323`): matches
   `constructor.name` with `$N`/`_N` suffix tolerance instead of `instanceof`, surviving
   Angular minor-version re-exports. Cautionary tale for our `@vue/compiler-sfc` coupling.
9. **PrimeNG dynamic-children selector patterns** (`element-detector.ts:224-288`): registry
   entries for overlay components carry a pre-built CSS pattern reaching the runtime
   overlay DOM. Niche but a neat answer to "the clickable thing isn't in the template".

## 5. Phase D design implications (evidence-based)

- The original stops at **template-visible names** everywhere — confirming Phase D's L2
  (resolve referenced symbols to their *definitions* and hash the bodies) has no prior art
  in either codebase and carries the real design risk we identified (script-side parsing,
  scope/import resolution, per-framework binding models, no ground truth).
- Its `@if/@for/@switch/@defer` blockContext handling (`template-parser.ts:142-205`) shows
  the per-framework surface keeps growing — reinforcing Phase D's "Vue `<script setup>`
  local-definitions first; imports opaque" increment strategy.
- Its strict static-text rule (`getStaticTextContent` returns null if any interpolation is
  present, `template-parser.ts:430-450`) is a good conservatism pattern for D: when
  resolution is uncertain, return *nothing* rather than something wrong.

## 6. Priority queue distilled from this analysis

1. Fix bound `:data-testid` handling in VueAdapter (confirmed bug, fights our own remedy).
2. Add leading-digit guard + regression test to `generateConstants`/`camelName`.
3. Adopt registry-stable first-mint slot inheritance (3-phase, fingerprint-exact) — closes
   the deferred spec §4.4 gap properly.
4. Safety nets (backup/rollback, retention, activity log, collision dump) — promote from
   HANDOFF P5 when the service route matures; canonical-JSON writes can land any time.
5. Context anchors — only with fingerprint-only/opt-in semantics (ripple noise measured).
