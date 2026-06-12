# Adapter Signal Matrix (audit result, parity-tested)

The closed `RawSignals` contract is only as good as each adapter's mapping into it.
This matrix is the audited vocabulary → slot table for the three real adapters; the
rules below are CONTRACT-LEVEL and enforced by `test/adapters/parity.test.ts` (the same
semantic markup in each framework must produce the same identity key).

## Rules

1. **Named slot = static attribute ?? bound-expression root.** A wired-by-code binding
   is exactly as identity-worthy as the static form (`[name]="field"` ≡ `name="field"`
   at the root level). Angular additionally resolves the `[attr.<name>]` form.
2. **`explicit_key` is the one exception: authored literals only.** A bound
   `:data-tid` is dynamic by definition and cannot serve as the absolute anchor; the
   expression still lands in `bound_identifiers`/`static_attributes` like any binding.
3. **Raw expression text always lands in `static_attributes`** (`[src]=`/`:src=`/`{src}`
   keys) — fingerprint-only, so expression-level edits flag `modified` without moving ids.
4. **A bound `data-testid`/`data-cy` skips the element entirely** (the per-item loop fix).

## Matrix

| Slot | Vue | Angular | React |
| --- | --- | --- | --- |
| `explicit_key` | `data-tid` (literal) | `data-tid` (literal) | `data-tid` (literal) |
| `form_control` | `v-model` ?? name (s/b) | `formControlName` (s/b) ?? `[ngModel]` ?? name (s/b/attr.) | name (s/b) |
| `name` | s/b | s/b/attr. | s/b |
| `route` | `to`/`href` (s/b) | `routerLink`/`href` (s/b/attr.) | `to`/`href` (s/b) |
| `event_handlers` | `@event` → handler name | `(event)` → handler name | `on<Event>` → AST-resolved handler (arrows → called fn) |
| `bound_identifiers` | `:prop` → root path | `[prop]` → root path | `prop={…}` → root path (`key`/`ref` excluded) |
| `html_id`, `aria_label`, `placeholder`, `type`, `role` | s/b | s/b/attr. | s/b |
| `text` | direct text nodes | direct Text (not BoundText) | direct JSXText |
| `static_attributes` | raw `:`/`@`/`v-model` exprs | raw `[…]`/`(…)` exprs | raw `{…}` exprs |
| `inLoop` | `v-for` | `*ngFor` / `@for` | `.map()` / `.flatMap()` ancestry |

(s = static attribute, b = bound root, attr. = Angular `[attr.<name>]` form.)

## Audit history

2026-06-12 audit found and fixed: Angular missed `[formControlName]`, `[name]`,
`[href]`, `[id]`, `[attr.aria-label]` and friends (static-only lookups); React missed
`name={…}`, `href={…}` and friends; Vue accepted a bound `:data-tid` as `explicit_key`
(too wide — rule 2). Upgrade note: elements that previously fell to a weaker key
because a binding form was invisible may re-key on the next `--regenerate`; written
ids stay sticky regardless.

Same-day follow-up (triggered by "is coverage an adapter concern?"): the
`tabindex >= 0` criterion of `isInteractive` read `static_attributes.tabindex`, which
no real adapter populated for the static form — focusable custom controls were missing
from the interactive-coverage denominator. All adapters now pass static `tabindex`
through (parity-tested). Coverage itself stays core-owned (engine tag stats,
`src/testmap/` static report, `src/runtime/` recorder); adapters only feed the
denominator — which is precisely why their mappings need this audit gate.
