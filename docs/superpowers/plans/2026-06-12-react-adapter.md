# React Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real AST-backed `ReactAdapter` (the last sketch in `sketches.ts`) so JSX/TSX
projects get the same key quality, L2 symbol tracking, and test-routing the Vue and
Angular adapters deliver — validated by a real-project history replay.

**Architecture:** Same shape as the other adapters: `@babel/parser` (already a transitive
dep via the Vue fallback; promoted to a direct dep) parses the whole file
(`jsx` + `typescript` plugins); a recursive walk collects `JSXElement` nodes and maps JSX
vocabulary into the closed `RawSignals` contract. React-specific decisions:

- **One source node → N runtime instances** (JSX has no static DOM): identity is built
  from the element's own props only and all instances share one id — documented, not
  fought. `.map()`/`.flatMap()` call-expression ancestry sets `inLoop` (the JSX analog of
  `v-for`), warning that a static id is shared per item.
- Vocabulary: `on<Event>={h}` → `event_handlers` (lowercased, `on` stripped);
  expression-valued props → `bound_identifiers` (first-identifier-path) + raw expression
  text into `static_attributes` as `{prop}` (fingerprint-only); string props feed the
  named slots (`name`, `to`/`href` → route, `aria-label`, `placeholder`, `type`, `role`,
  `id`); direct `JSXText` → text. `className` stays out of identity (invariant 1).
- An expression-valued `data-testid={...}` is the per-item fix: respected, skipped
  entirely (same as Vue `:data-testid` / Angular `[attr.data-testid]`).
- `write` reuses `applyTestIdEdits`; `loc.end` = `'>'` of the opening element from AST
  spans (arrow-safe by construction; self-closing `/>` handled like HTML void tags).
- `resolveSymbolDefs` works on the **same file** (handlers live next to the JSX):
  recursive scan for named declarations (function/const/class members/imports —
  **including `export default` unwrap**, the Angular Y31 lesson) and slice their source
  text; imports stay the L3 opaque boundary.
- CLI: `--ext .jsx,.tsx` (and `.js` opt-in via `--adapter react` for legacy CRA-style
  repos); extension-based auto-pick; mixed sets rejected.

**Tech Stack:** TypeScript 5.x, Vitest 4, `@babel/parser` (direct dep).

**Design inputs:** `sketches.ts` React sketch (graduates on completion); CLAUDE.md React
constraint note; `docs/findings/2026-06-12-realworld-angular-history-replay.md` (replay
method + the two gap-classes to test for: raw-expression fingerprints, export-default L2).

**Tasks (TDD each):**
1. Plan + empirical probe of `@babel/parser` JSX node shapes/spans (opening-element end,
   attribute values, `.map` ancestry) before coding.
2. `ReactAdapter.parse` + `write`: signals mapping, `inLoop`, bound-testid skip,
   fragment/member-expression tags, idempotent write.
3. `resolveSymbolDefs`: same-file slicing (top-level + component-body declarations,
   export-default unwrap, import boundary, missing-name degrade to null).
4. CLI: extension auto-pick + `--adapter react`; usage text.
5. **Acceptance:** real React project, real commit history, replay with the established
   merge method; verify sticky ids, diff precision, `symbol:*` routing, coverage; record
   findings.
6. Docs (README en/zh, USAGE en/zh, CLAUDE.md) + remove the graduated sketch.
