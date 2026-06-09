# testid-universal

A framework-agnostic TestID engine **distilled** from the build-time Angular tagger
idea (spachtholz/TestID-Generator). The original tool's value was never the Angular
parsing — it was the data flow:

> semantic key → fingerprint → deterministic id → versioned registry → diff → locators

That flow has **nothing to do with any UI framework**. Only two steps are framework-specific:
turning a template into elements, and writing an attribute back. This project pushes
those two steps into a thin **adapter** and turns everything else into a shared
**backend service**, so the same brain serves Angular, Vue, React, or anything that
renders a DOM.

## The one idea that makes it portable

A single intermediate representation, `ElementNode[]`, is the contract between the
framework world and the engine world:

```
Angular/Vue/React template ──[adapter.parse]──▶ ElementNode[] ──▶ ENGINE
                                                                    │
   tagged template ◀──[adapter.write]── edits ◀── ids + registry ◀─┘
```

The adapter normalizes each framework's vocabulary (`formControlName`, `v-model`,
React `name`, `routerLink`/`to`/`href`, …) into **canonical semantic hints**. The
engine only ever reasons about the canonical names. Vocabulary = adapter; policy = core.

## Layered structure

| Layer | Folder | Framework-aware? | Responsibility |
| --- | --- | --- | --- |
| Adapters | `src/adapters` | **Yes (only here)** | `parse()` template → IR, `write()` id back. Vocabulary map. |
| Core engine | `src/core` | No | key extraction, fingerprint, classification, id format, collision resolution. **Pure functions.** |
| Registry | `src/registry` | No | versioning, first/last-seen, source, regeneration history, **diff** (rename via fingerprint similarity). Storage-agnostic. |
| Locators | `src/locators` | No | emit Robot / Playwright / Cypress locators from the registry. |
| Backend | `src/server` | No | `TestIdService` (transport-agnostic) + a zero-dep `node:http` REST shell. |
| Client | `src/client` | No | pipeline: adapter → service → write-back. |

Dependencies point **downward only**: adapters depend on the contract, the client
orchestrates, and `core` depends on nothing but Node's `crypto`. The whole thing has
**zero runtime npm dependencies**.

## What's agnostic vs. what each framework must supply

**Agnostic (written once, shared by all):** id generation, collision/hash strategy,
fingerprinting, the registry + versioning, diff/rename detection, locator generation,
the backend API. ~90% of the code.

**Per-framework (one small adapter each):**
- `parse()` — use `@angular/compiler`, `@vue/compiler-sfc`, or `@babel/parser` to walk
  the template/JSX and emit `ElementNode[]`. See `src/adapters/sketches.ts`.
- `write()` — inject the attribute (offset splice for HTML-like templates; AST re-print
  for JSX).
- a `customTagMap` for the local component library (PrimeNG vs MUI vs Vuetify).

A working, dependency-free `HtmlTemplateAdapter` is included and is what the demo uses.

## Two ways to use it — same code, your choice

The engine is a plain library. A **transport** decides whether calls run in-process or
hit a server, and the pipeline/CLI depend only on that interface:

```ts
// EMBEDDED (default): no server, nothing to start. Registry persists as JSON files.
const transport = new LocalTransport(new JsonFileStorage('./test-artifacts/testids'));

// REMOTE: point at a backend. Every downstream call is identical.
const transport = new HttpTransport('http://localhost:7337');
```

Same idea on the CLI — embedded by default, `--server` to opt into the service:

```bash
# embedded — like a normal build tool, zero infrastructure
testid tag src/app --registry ./test-artifacts/testids
testid diff 1 2
testid gen-locators --target playwright --out tests/locators

# centralized — identical commands, add one flag
testid tag src/app --server http://localhost:7337
testid gen-locators --target playwright --server http://localhost:7337
```

So: **library/CLI when you just want it to work; a service when a team wants one
shared testid authority.** You never rewrite calling code to move between them.

## Why a backend at all

Making the engine + registry a *service* (the `HttpTransport` side) turns testids into
a centralized authority: any client in any language can `POST /tag` a list of
`ElementNode`s and get back assigned ids, edits, and a new registry version. Point the
storage at Postgres and it becomes multi-repo / multi-team. But that is strictly
opt-in — the embedded mode covers the common case with no moving parts.

### REST API

```
POST /tag                 { nodes, config? }                -> { version, assignments, edits, overrides }
GET  /registry/latest                                       -> RegistrySnapshot
GET  /diff?from=1&to=2&threshold=0.8                        -> DiffResult
GET  /locators?target=robot|playwright|cypress&attr=...     -> { [file]: content }
```

## Run it

```bash
npm run demo     # end-to-end EMBEDDED: tag v1, edit, tag v2, diff (rename+modify), locators, determinism check
npm run cli -- tag <paths> --registry ./reg    # the CLI, fully embedded (no server)
npm run serve    # OPTIONAL: boot the backend on :7337 for --server mode
```

Re-running `tag` on an already-tagged file is idempotent — existing ids are rewritten
in place, never duplicated.

## Extending

- **New framework:** implement `FrameworkAdapter` (`parse` + `write`). Nothing else changes.
- **New test stack:** add one function in `src/locators`.
- **New storage:** implement `RegistryStorage` (in-memory and JSON-file included).

## Relationship to the original

This is a clean-room *distillation of the concept*, not a fork: the determinism model,
the fingerprint-vs-id split, the versioned registry, and the diff categories are taken
as design inspiration; the code here is independent and framework-neutral.
