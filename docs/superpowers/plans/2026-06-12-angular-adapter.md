# Angular Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real AST-backed `AngularAdapter` (HANDOFF P2) so Angular projects get the same key quality and L2 symbol tracking the Vue adapter delivers — and the head-to-head comparison can be rerun at full fidelity.

**Architecture:** Same shape as `VueAdapter`: `@angular/compiler`'s `parseTemplate` (optional peer, lazily required) walks the template AST; vocabulary maps into the closed `RawSignals` contract (attributes → named slots, `(outputs)` → `event_handlers`, `[inputs]` → `bound_identifiers` first-identifier-path, `*ngFor`/`@for` → `inLoop`); `write` reuses `applyTestIdEdits` with AST-accurate opening-tag spans. `resolveSymbolDefs` reads the companion `*.component.ts` (filename pairing + `templateUrl` soft check) and slices class members / top-level declarations via `@babel/parser` (transitive dep, graceful all-null degrade). CLI auto-pick gains content sniffing: `.vue` → Vue; `.html` with Angular markers (`(event)=`, `[prop]=`, `*ngIf/For`, `@if(/@for(`, `formControlName`, `routerLink`, `<ng-container>`) → Angular; other `.html` → HTML; `--adapter` always wins.

**Tech Stack:** TypeScript 5.x, Vitest 4, `@angular/compiler` (new optional peer + devDep).

**Design inputs:** `docs/findings/2026-06-12-head-to-head-comparison.md` (proxy limits, detection design, acceptance baseline), original tool's `template-parser.ts` as AST-walk reference.

**Tasks (TDD each):**
1. Add `@angular/compiler` (devDep + optional peer); empirical probe of `parseTemplate` node shapes/spans before coding.
2. `AngularAdapter.parse`: elements with attrs/inputs/outputs mapped to `RawSignals`; `loc` from `startSourceSpan` (arrow-safe by construction); skip `ng-container`/`ng-template` and author-bound `[attr.data-testid]`; `inLoop` via `Template` (structural) and `@for` block nodes.
3. `write` (shared idempotent helper) + idempotency test.
4. `resolveSymbolDefs`: companion `.ts` discovery + babel class-member/top-level/import slicing; degrade to null without companion or parser.
5. CLI: `--adapter angular` + content-sniff auto-pick; usage/docs.
6. **Acceptance:** rerun the 6-step comparison stream with the real adapter (`cmp-ours-ng` branch): buttons handler-keyed (unstable warnings drop), loop warnings on the `*ngFor` subtree, entries approach the original's surface; update the comparison findings with the full-fidelity column; docs (README/USAGE/CLAUDE.md).
