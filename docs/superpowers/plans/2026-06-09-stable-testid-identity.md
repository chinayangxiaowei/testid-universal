# Stable TestID Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the identity/fingerprint/diff core so every testid locates exactly one element, stays stable against unrelated edits, and produces a deterministic, field-level change report.

**Architecture:** A core-owned closed `RawSignals` contract (tiered by stability). Core derives two artifacts from it: a stable `identity` (code-wired signals, copy excluded) used for exact cross-version matching, and a rich `fingerprint` (all signals) used only to detect `modified` and report which fields changed. Ids become unique by deterministic disambiguation; the both-sides collision hash is removed. Adapters only map framework vocabulary into the contract.

**Tech Stack:** TypeScript 5.x, Node 20+, Vitest 4, `@vue/compiler-sfc` (Vue adapter).

**Spec:** `docs/superpowers/specs/2026-06-09-stable-testid-identity-design.md`

**Scope note:** This plan covers the core redesign and adapter conformance (HTML + Vue). The fail-closed *test-adaptation workflow* (tests consuming generated id constants, a diff→test-action tool) is a separate follow-up plan. **Deferred from spec §4.4:** registry-stable incumbent preservation for *same-identity* groups is implemented as deterministic document-order disambiguation only; cross-version incumbent matching for truly-identical unkeyed siblings is left to the follow-up (those elements already emit a stability warning telling the author to add an explicit key).

**Conventions:** Code, comments, and commit messages in English. Run all commands from the `main/` worktree.

---

### Task 1: Signal contract + normalizer

**Files:**
- Modify: `src/core/types.ts` (replace `SemanticHints`/`SEMANTIC_KEYS`, update `ElementNode`)
- Create: `src/core/signals.ts`
- Test: `test/core/signals.test.ts`

- [ ] **Step 1: Add the contract types to `src/core/types.ts`**

Replace the `SemanticHints` interface and `SEMANTIC_KEYS` const with:

```ts
/**
 * The closed signal contract every adapter fills. Tiered by stability:
 * Tier 0 explicit anchor, Tier 1 code-wired, Tier 2 structural, Tier 3 copy.
 * Identity is derived only from stable slots; `static_attributes` feeds the
 * fingerprint only and never influences identity.
 */
export interface RawSignals {
  explicit_key?: string | null;
  form_control?: string | null;
  name?: string | null;
  route?: string | null;
  event_handlers?: Record<string, string>;
  bound_identifiers?: Record<string, string>;
  html_id?: string | null;
  structural?: Record<string, string>;
  child_shape?: string[];
  context?: Record<string, string>;
  semantic_css?: string[];
  text?: string | null;
  aria_label?: string | null;
  placeholder?: string | null;
  title?: string | null;
  alt?: string | null;
  value?: string | null;
  type?: string | null;
  role?: string | null;
  static_attributes?: Record<string, string>;
}

/** RawSignals after normalization: every slot resolved (null / {} / []). */
export interface NormalizedSignals {
  explicit_key: string | null;
  form_control: string | null;
  name: string | null;
  route: string | null;
  event_handlers: Record<string, string>;
  bound_identifiers: Record<string, string>;
  html_id: string | null;
  structural: Record<string, string>;
  child_shape: string[];
  context: Record<string, string>;
  semantic_css: string[];
  text: string | null;
  aria_label: string | null;
  placeholder: string | null;
  title: string | null;
  alt: string | null;
  value: string | null;
  type: string | null;
  role: string | null;
  static_attributes: Record<string, string>;
}

export interface Warning {
  code: 'unstable-identity' | 'positional-disambiguator';
  element_type: string;
  identity: string;
  message: string;
}
```

Change `ElementNode` to carry `signals` instead of `semantic`:

```ts
export interface ElementNode {
  component: string;
  tag: string;
  signals: RawSignals;
  loc?: SourceLoc;
  existingId?: string | null;
}
```

- [ ] **Step 2: Write the failing test `test/core/signals.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeSignals } from '../../src/core/signals';

describe('normalizeSignals', () => {
  it('resolves every slot and trims/collapses scalar whitespace', () => {
    const n = normalizeSignals({ form_control: '  email ', text: 'Sign   in' });
    expect(n.form_control).toBe('email');
    expect(n.text).toBe('Sign in');
    expect(n.name).toBeNull();
    expect(n.event_handlers).toEqual({});
    expect(n.child_shape).toEqual([]);
  });

  it('turns empty/whitespace scalars into null', () => {
    expect(normalizeSignals({ name: '   ', aria_label: '' }).name).toBeNull();
    expect(normalizeSignals({ aria_label: '' }).aria_label).toBeNull();
  });

  it('lowercases map keys and drops empty map values', () => {
    const n = normalizeSignals({ event_handlers: { Click: 'saveOrder', Blur: '' } });
    expect(n.event_handlers).toEqual({ click: 'saveOrder' });
  });

  it('dedupes + sorts semantic_css but preserves child_shape order', () => {
    const n = normalizeSignals({ semantic_css: ['b', 'a', 'a'], child_shape: ['span', 'icon', 'span'] });
    expect(n.semantic_css).toEqual(['a', 'b']);
    expect(n.child_shape).toEqual(['span', 'icon', 'span']);
  });

  it('throws when a map value is not a string', () => {
    // @ts-expect-error intentional bad shape
    expect(() => normalizeSignals({ event_handlers: { click: 3 } })).toThrow(/event_handlers/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/core/signals.test.ts`
Expected: FAIL — cannot find module `../../src/core/signals`.

- [ ] **Step 4: Implement `src/core/signals.ts`**

```ts
import { RawSignals, NormalizedSignals } from './types';

function norm(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : null;
}

function normMap(name: string, m: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== 'string') throw new Error(`signals.${name}: value for "${k}" must be a string`);
    const nv = norm(v);
    if (nv) out[k.toLowerCase()] = nv;
  }
  return out;
}

function normList(arr: string[] | undefined, sortDedupe: boolean): string[] {
  if (!arr) return [];
  const cleaned = arr.map((s) => norm(s)).filter((s): s is string => s != null);
  if (!sortDedupe) return cleaned;
  return [...new Set(cleaned.map((s) => s.toLowerCase()))].sort();
}

export function normalizeSignals(raw: RawSignals): NormalizedSignals {
  return {
    explicit_key: norm(raw.explicit_key),
    form_control: norm(raw.form_control),
    name: norm(raw.name),
    route: norm(raw.route),
    event_handlers: normMap('event_handlers', raw.event_handlers),
    bound_identifiers: normMap('bound_identifiers', raw.bound_identifiers),
    html_id: norm(raw.html_id),
    structural: normMap('structural', raw.structural),
    child_shape: normList(raw.child_shape, false),
    context: normMap('context', raw.context),
    semantic_css: normList(raw.semantic_css, true),
    text: norm(raw.text),
    aria_label: norm(raw.aria_label),
    placeholder: norm(raw.placeholder),
    title: norm(raw.title),
    alt: norm(raw.alt),
    value: norm(raw.value),
    type: norm(raw.type),
    role: norm(raw.role),
    static_attributes: normMap('static_attributes', raw.static_attributes),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/core/signals.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/signals.ts test/core/signals.test.ts
git commit -m "Add closed RawSignals contract and normalizer"
```

---

### Task 2: Identity selection

**Files:**
- Modify: `src/core/semantic.ts` (keep `slugify`, remove `selectKey`/`keyFor`)
- Create: `src/core/identity.ts`
- Test: `test/core/identity.test.ts`

- [ ] **Step 1: Trim `src/core/semantic.ts` to just `slugify`**

Replace the whole file with:

```ts
/** Lowercase, collapse non-alphanumerics to single dashes, trim dashes. */
export function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 2: Write the failing test `test/core/identity.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { selectIdentityKey, identityOf } from '../../src/core/identity';
import { normalizeSignals } from '../../src/core/signals';

const sig = (raw: Parameters<typeof normalizeSignals>[0]) => normalizeSignals(raw);

describe('selectIdentityKey', () => {
  it('prefers code-wired signals over display copy', () => {
    const r = selectIdentityKey(sig({ form_control: 'email', text: 'Email address', aria_label: 'Email' }), 'input');
    expect(r).toMatchObject({ value: 'email', source: 'form_control', stable: true });
  });

  it('ranks explicit_key highest', () => {
    const r = selectIdentityKey(sig({ explicit_key: 'login/submit', form_control: 'x' }), 'button');
    expect(r).toMatchObject({ value: 'login/submit', source: 'explicit_key', stable: true });
  });

  it('places html_id below form_control/name/route', () => {
    const r = selectIdentityKey(sig({ html_id: 'cust-dd', route: '/x' }), 'a');
    expect(r.source).toBe('route');
  });

  it('falls to copy only as a last resort and marks it unstable', () => {
    const r = selectIdentityKey(sig({ text: 'Sign in' }), 'button');
    expect(r).toMatchObject({ value: 'Sign in', source: 'text', stable: false });
  });

  it('falls back to the tag when nothing is present (unstable)', () => {
    const r = selectIdentityKey(sig({}), 'section');
    expect(r).toMatchObject({ value: 'section', source: 'tag', stable: false });
  });

  it('picks a deterministic preferred event handler', () => {
    const r = selectIdentityKey(sig({ event_handlers: { blur: 'onBlur', click: 'saveOrder' } }), 'button');
    expect(r).toMatchObject({ value: 'saveOrder', source: 'event_handlers' });
  });
});

describe('identityOf', () => {
  it('joins component, element short and slugified key', () => {
    expect(identityOf('login', 'input', 'email')).toBe('login::input::email');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/core/identity.test.ts`
Expected: FAIL — cannot find module `../../src/core/identity`.

- [ ] **Step 4: Implement `src/core/identity.ts`**

```ts
import { NormalizedSignals } from './types';
import { slugify } from './semantic';

export type IdentitySource =
  | 'explicit_key' | 'form_control' | 'name' | 'route'
  | 'event_handlers' | 'bound_identifiers' | 'html_id' | 'structural'
  | 'child_shape' | 'text' | 'aria_label' | 'placeholder' | 'tag';

/** Sources whose value is volatile display copy (or the bare tag fallback). */
const UNSTABLE_SOURCES: ReadonlySet<IdentitySource> = new Set(['text', 'aria_label', 'placeholder', 'tag']);

function preferredMapValue(m: Record<string, string>, preferred: string[]): string | null {
  for (const k of preferred) if (m[k]) return m[k];
  const keys = Object.keys(m).sort();
  return keys.length ? m[keys[0]]! : null;
}

/** Ordered extractors: first non-empty wins. html_id is intentionally low. */
function valueForSource(sig: NormalizedSignals, source: IdentitySource): string | null {
  switch (source) {
    case 'explicit_key': return sig.explicit_key;
    case 'form_control': return sig.form_control;
    case 'name': return sig.name;
    case 'route': return sig.route;
    case 'event_handlers': return preferredMapValue(sig.event_handlers, ['click', 'submit', 'change', 'input']);
    case 'bound_identifiers': return preferredMapValue(sig.bound_identifiers, ['data', 'value', 'model', 'item', 'items']);
    case 'html_id': return sig.html_id;
    case 'structural': return preferredMapValue(sig.structural, ['ngif', 'ngfor', 'if', 'for']);
    case 'child_shape': return sig.child_shape.length ? sig.child_shape.join('-') : null;
    case 'text': return sig.text;
    case 'aria_label': return sig.aria_label;
    case 'placeholder': return sig.placeholder;
    case 'tag': return null;
  }
}

export const IDENTITY_KEY_PRIORITY: readonly IdentitySource[] = [
  'explicit_key', 'form_control', 'name', 'route', 'event_handlers',
  'bound_identifiers', 'html_id', 'structural', 'child_shape',
  'text', 'aria_label', 'placeholder',
];

export interface IdentityKey { value: string; source: IdentitySource; stable: boolean }

export function selectIdentityKey(sig: NormalizedSignals, tag: string): IdentityKey {
  for (const source of IDENTITY_KEY_PRIORITY) {
    const v = valueForSource(sig, source);
    if (v != null && v.length > 0) return { value: v, source, stable: !UNSTABLE_SOURCES.has(source) };
  }
  return { value: tag, source: 'tag', stable: false };
}

/** The stable matching key (no disambiguator). */
export function identityOf(component: string, elementShort: string, identityKey: string): string {
  return `${slugify(component)}::${slugify(elementShort)}::${slugify(identityKey)}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/core/identity.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/semantic.ts src/core/identity.ts test/core/identity.test.ts
git commit -m "Add identity-key selection (code-wired first, copy last, html_id low)"
```

---

### Task 3: Rich fingerprint over all signals

**Files:**
- Modify: `src/core/fingerprint.ts` (full rewrite; drop `hashOf`)
- Test: `test/core/fingerprint.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the test `test/core/fingerprint.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { fingerprintOf } from '../../src/core/fingerprint';
import { normalizeSignals } from '../../src/core/signals';

const fp = (tag: string, raw: Parameters<typeof normalizeSignals>[0]) =>
  fingerprintOf(tag, normalizeSignals(raw));

describe('fingerprintOf', () => {
  it('is deterministic and independent of authoring order', () => {
    const a = fp('input', { form_control: 'email', type: 'email', text: 'Email' });
    const b = fp('input', { text: 'Email', type: 'email', form_control: 'email' });
    expect(a).toBe(b);
  });

  it('starts with the tag', () => {
    expect(fp('button', { text: 'Go' })).toMatch(/^button\|/);
  });

  it('includes display copy (so a copy edit changes the fingerprint)', () => {
    expect(fp('button', { event_handlers: { click: 'go' }, text: 'Sign in' }))
      .not.toBe(fp('button', { event_handlers: { click: 'go' }, text: 'Login' }));
  });

  it('folds maps in sorted-key order', () => {
    const a = fp('div', { event_handlers: { b: 'B', a: 'A' } });
    const b = fp('div', { event_handlers: { a: 'A', b: 'B' } });
    expect(a).toBe(b);
  });

  it('includes static_attributes (fingerprint-only catch-all)', () => {
    expect(fp('p-button', { static_attributes: { severity: 'danger' } }))
      .not.toBe(fp('p-button', { static_attributes: { severity: 'info' } }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/fingerprint.test.ts`
Expected: FAIL — `fingerprintOf` signature changed / `hashOf` references.

- [ ] **Step 3: Rewrite `src/core/fingerprint.ts`**

```ts
/**
 * Fingerprint — the rich descriptive signature of "what this element is".
 *
 * Built from ALL signals (including display copy and static_attributes) in a
 * fixed canonical order, so reordering attributes never changes it. Used only
 * to detect `modified` and to report which fields changed — NEVER for matching.
 * Matching is by `identity` (see identity.ts), which excludes copy.
 */
import { NormalizedSignals } from './types';

function pushScalar(parts: string[], key: string, v: string | null) {
  if (v != null && v.length > 0) parts.push(`${key}=${v}`);
}
function pushMap(parts: string[], key: string, m: Record<string, string>) {
  for (const k of Object.keys(m).sort()) parts.push(`${key}.${k}=${m[k]}`);
}
function pushList(parts: string[], key: string, arr: string[]) {
  if (arr.length) parts.push(`${key}=${arr.join(',')}`);
}

export function fingerprintOf(tag: string, sig: NormalizedSignals): string {
  const parts: string[] = [tag.toLowerCase()];
  pushScalar(parts, 'explicit_key', sig.explicit_key);
  pushScalar(parts, 'form_control', sig.form_control);
  pushScalar(parts, 'name', sig.name);
  pushScalar(parts, 'route', sig.route);
  pushMap(parts, 'on', sig.event_handlers);
  pushMap(parts, 'bound', sig.bound_identifiers);
  pushScalar(parts, 'html_id', sig.html_id);
  pushMap(parts, 'struct', sig.structural);
  pushList(parts, 'child_shape', sig.child_shape);
  pushMap(parts, 'ctx', sig.context);
  pushList(parts, 'class', sig.semantic_css);
  pushScalar(parts, 'text', sig.text);
  pushScalar(parts, 'aria_label', sig.aria_label);
  pushScalar(parts, 'placeholder', sig.placeholder);
  pushScalar(parts, 'title', sig.title);
  pushScalar(parts, 'alt', sig.alt);
  pushScalar(parts, 'value', sig.value);
  pushScalar(parts, 'type', sig.type);
  pushScalar(parts, 'role', sig.role);
  pushMap(parts, 'attr', sig.static_attributes);
  return parts.join('|');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/fingerprint.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/fingerprint.ts test/core/fingerprint.test.ts
git commit -m "Rewrite fingerprint as rich descriptive signature over all signals"
```

---

### Task 4: Classify reads from signals

**Files:**
- Modify: `src/core/classify.ts`
- Test: `test/core/classify.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the test `test/core/classify.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { classify } from '../../src/core/classify';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { normalizeSignals } from '../../src/core/signals';

const cls = (tag: string, raw: Parameters<typeof normalizeSignals>[0], cfg = DEFAULT_CONFIG) =>
  classify(tag, normalizeSignals(raw), cfg);

describe('classify', () => {
  it('encodes input type into the long type', () => {
    expect(cls('input', { type: 'email' })).toEqual({ short: 'input', long: 'native_input_email' });
  });
  it('defaults input type to text', () => {
    expect(cls('input', {})).toEqual({ short: 'input', long: 'native_input_text' });
  });
  it('classifies common native tags', () => {
    expect(cls('button', {}).long).toBe('native_button');
    expect(cls('a', {})).toEqual({ short: 'link', long: 'native_link' });
  });
  it('falls back to element_<tag> for unknown tags', () => {
    expect(cls('my-widget', {})).toEqual({ short: 'my-widget', long: 'element_my-widget' });
  });
  it('lets customTagMap override', () => {
    const cfg = { ...DEFAULT_CONFIG, customTagMap: { 'v-btn': { short: 'button', long: 'vuetify_btn' } } };
    expect(cls('v-btn', {}, cfg)).toEqual({ short: 'button', long: 'vuetify_btn' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/classify.test.ts`
Expected: FAIL — `classify` still takes an `ElementNode` with `.semantic`.

- [ ] **Step 3: Rewrite `src/core/classify.ts`**

```ts
import { NormalizedSignals, ElementType, CoreConfig } from './types';

const NATIVE: Record<string, (sig: NormalizedSignals) => ElementType> = {
  input: (s) => ({ short: 'input', long: `native_input_${s.type ?? 'text'}` }),
  textarea: () => ({ short: 'textarea', long: 'native_textarea' }),
  select: () => ({ short: 'select', long: 'native_select' }),
  button: () => ({ short: 'button', long: 'native_button' }),
  a: () => ({ short: 'link', long: 'native_link' }),
  form: () => ({ short: 'form', long: 'native_form' }),
  label: () => ({ short: 'label', long: 'native_label' }),
  img: () => ({ short: 'img', long: 'native_img' }),
};

export function classify(tag: string, sig: NormalizedSignals, config: CoreConfig): ElementType {
  const custom = config.customTagMap[tag] ?? config.customTagMap[tag.toLowerCase()];
  if (custom) return { short: custom.short, long: custom.long };
  const native = NATIVE[tag.toLowerCase()];
  if (native) return native(sig);
  const short = tag.toLowerCase();
  return { short, long: `element_${short}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/classify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/classify.ts test/core/classify.test.ts
git commit -m "Classify from normalized signals"
```

---

### Task 5: Id format (disambiguator), config, and core barrel

**Files:**
- Modify: `src/core/format.ts`
- Modify: `src/core/types.ts` (`CoreConfig`, `DEFAULT_CONFIG`, `EntryDraft`, `ElementType`)
- Modify: `src/core/index.ts`
- Test: `test/core/format.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the test `test/core/format.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { formatId } from '../../src/core/format';

const TPL = '{component}__{element}--{key}{disambiguator:--}';

describe('formatId', () => {
  it('omits the disambiguator separator when none is needed', () => {
    expect(formatId(TPL, { component: 'login', element: 'input', key: 'email', tag: 'input', disambiguator: '' }))
      .toBe('login__input--email');
  });
  it('prefixes the disambiguator with -- when present', () => {
    expect(formatId(TPL, { component: 'login', element: 'input', key: 'email', tag: 'input', disambiguator: '2' }))
      .toBe('login__input--email--2');
  });
  it('supports {tag} and bare {disambiguator}', () => {
    expect(formatId('{tag}@{disambiguator}', { component: 'c', element: 'e', key: 'k', tag: 'button', disambiguator: 'x' }))
      .toBe('button@x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/format.test.ts`
Expected: FAIL — `IdTokens` still uses `hash`.

- [ ] **Step 3: Rewrite `src/core/format.ts`**

```ts
/**
 * Id formatting. Tokens: {component} {element} {key} {tag} {disambiguator}
 * {disambiguator:--}. The `:--` form expands to "--<value>" only when a
 * disambiguator is present, keeping the common unique case clean.
 */
export interface IdTokens {
  component: string;
  element: string;
  key: string;
  tag: string;
  disambiguator: string;
}

export function formatId(template: string, t: IdTokens): string {
  return template
    .replace(/\{disambiguator:--\}/g, t.disambiguator ? `--${t.disambiguator}` : '')
    .replace(/\{component\}/g, t.component)
    .replace(/\{element\}/g, t.element)
    .replace(/\{key\}/g, t.key)
    .replace(/\{tag\}/g, t.tag)
    .replace(/\{disambiguator\}/g, t.disambiguator);
}
```

- [ ] **Step 4: Update `src/core/types.ts` config + draft + element type**

Replace `ElementType`, `EntryDraft`, `CoreConfig`, `DEFAULT_CONFIG` with:

```ts
export interface ElementType { short: string; long: string }

export interface EntryDraft {
  id: string;
  component: string;
  tag: string;
  element_type: string;   // long form
  identity: string;       // stable matching key (no disambiguator)
  identity_key: string;   // slug used in {key}
  fingerprint: string;    // rich descriptive
  signals: NormalizedSignals;
  loc?: SourceLoc;
}

export interface CustomTagMapEntry { short: string; long: string }

export interface CoreConfig {
  /** Naming template. Tokens: {component} {element} {key} {tag} {disambiguator} {disambiguator:--}. */
  idFormat: string;
  attributeName: string;
  /** Attribute an adapter reads as the explicit stable key (Tier 0). */
  explicitKeyAttribute: string;
  customTagMap: Record<string, CustomTagMapEntry>;
  ignoreTags: string[];
}

export const DEFAULT_CONFIG: CoreConfig = {
  idFormat: '{component}__{element}--{key}{disambiguator:--}',
  attributeName: 'data-testid',
  explicitKeyAttribute: 'data-tid',
  customTagMap: {},
  ignoreTags: [],
};
```

- [ ] **Step 5: Update `src/core/index.ts`**

```ts
export * from './types';
export * from './signals';
export * from './semantic';
export * from './identity';
export * from './fingerprint';
export * from './classify';
export * from './format';
export * from './engine';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/core/format.test.ts`
Expected: PASS (3 tests). (`src/core` will not type-check yet — engine still references old APIs; fixed in Task 6.)

- [ ] **Step 7: Commit**

```bash
git add src/core/format.ts src/core/types.ts src/core/index.ts test/core/format.test.ts
git commit -m "Switch id format to disambiguator; update config and draft types"
```

---

### Task 6: Engine — generate drafts with unique, stable ids

**Files:**
- Modify: `src/core/engine.ts` (full rewrite)
- Test: `test/core/engine.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the test `test/core/engine.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { generate, shouldTag } from '../../src/core/engine';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { node } from '../helpers';

const cfg = DEFAULT_CONFIG;

describe('shouldTag', () => {
  it('skips elements with no signal and no existing id', () => {
    expect(shouldTag(node({ tag: 'div', signals: {} }), cfg)).toBe(false);
  });
  it('tags elements carrying any signal', () => {
    expect(shouldTag(node({ tag: 'input', signals: { form_control: 'email' } }), cfg)).toBe(true);
  });
  it('respects ignoreTags', () => {
    expect(shouldTag(node({ tag: 'svg', signals: { aria_label: 'icon' } }), { ...cfg, ignoreTags: ['svg'] })).toBe(false);
  });
});

describe('generate', () => {
  it('derives a clean id from a stable code-wired key', () => {
    const { drafts } = generate([
      node({ tag: 'input', signals: { form_control: 'email', type: 'email' } }),
      node({ tag: 'button', signals: { event_handlers: { click: 'login' }, text: 'Sign in' } }),
    ], cfg);
    expect(drafts.map((d) => d.id)).toEqual(['login__input--email', 'login__button--login']);
  });

  it('does NOT change an element id when an unrelated element is added', () => {
    const a = node({ tag: 'input', signals: { form_control: 'email' } });
    const idAlone = generate([a], cfg).drafts[0].id;
    const idWithSibling = generate([a, node({ tag: 'input', signals: { form_control: 'password' } })], cfg)
      .drafts.find((d) => d.identity.endsWith('::email'))!.id;
    expect(idWithSibling).toBe(idAlone);
  });

  it('keeps a stable id when only display copy changes', () => {
    const v1 = generate([node({ tag: 'button', signals: { event_handlers: { click: 'login' }, text: 'Sign in' } })], cfg);
    const v2 = generate([node({ tag: 'button', signals: { event_handlers: { click: 'login' }, text: 'Login' } })], cfg);
    expect(v2.drafts[0].id).toBe(v1.drafts[0].id);
    expect(v2.drafts[0].fingerprint).not.toBe(v1.drafts[0].fingerprint);
  });

  it('disambiguates identical siblings so every id is unique, with a warning', () => {
    const { drafts, warnings } = generate([
      node({ tag: 'button', signals: { text: 'Delete' } }),
      node({ tag: 'button', signals: { text: 'Delete' } }),
    ], cfg);
    const ids = drafts.map((d) => d.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(['login__button--delete', 'login__button--delete--2']);
    expect(warnings.some((w) => w.code === 'positional-disambiguator')).toBe(true);
  });

  it('warns when identity falls back to display copy', () => {
    const { warnings } = generate([node({ tag: 'button', signals: { text: 'Save' } })], cfg);
    expect(warnings.some((w) => w.code === 'unstable-identity')).toBe(true);
  });

  it('prefers a distinguishing stable signal over a positional index', () => {
    const { drafts } = generate([
      node({ tag: 'a', signals: { text: 'Open', route: '/a' } }),
      node({ tag: 'a', signals: { text: 'Open', route: '/b' } }),
    ], cfg);
    // identity key is `route` (stable) so the two are already distinct identities — no positional suffix.
    expect(new Set(drafts.map((d) => d.id)).size).toBe(2);
    expect(drafts.every((d) => !d.id.includes('--2'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/engine.test.ts`
Expected: FAIL — `generate` returns an array / old signature.

- [ ] **Step 3: Rewrite `src/core/engine.ts`**

```ts
import { ElementNode, EntryDraft, CoreConfig, Warning } from './types';
import { normalizeSignals } from './signals';
import { classify } from './classify';
import { slugify } from './semantic';
import { selectIdentityKey, identityOf } from './identity';
import { fingerprintOf } from './fingerprint';
import { formatId } from './format';

export function shouldTag(node: ElementNode, config: CoreConfig): boolean {
  const tag = node.tag;
  if (config.ignoreTags.includes(tag) || config.ignoreTags.includes(tag.toLowerCase())) return false;
  if (node.existingId) return true;
  const s = node.signals;
  return Object.values(s).some((v) => {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return Object.keys(v).length > 0;
  });
}

export interface GenerateResult { drafts: EntryDraft[]; warnings: Warning[] }

interface Pre {
  node: ElementNode;
  short: string;
  long: string;
  identityKey: string;
  stable: boolean;
  fingerprint: string;
  identity: string;
}

export function generate(nodes: ElementNode[], config: CoreConfig): GenerateResult {
  const warnings: Warning[] = [];
  const pre: Pre[] = [];

  for (const node of nodes) {
    if (!shouldTag(node, config)) continue;
    const sig = normalizeSignals(node.signals);
    const { short, long } = classify(node.tag, sig, config);
    const key = selectIdentityKey(sig, node.tag);
    const identity = identityOf(node.component, short, key.value);
    if (!key.stable) {
      warnings.push({
        code: 'unstable-identity', element_type: long, identity,
        message: `identity for ${identity} comes from "${key.source}" (volatile); add an explicit ${config.explicitKeyAttribute} key for a stable testid`,
      });
    }
    pre.push({ node, short, long, identityKey: key.value, stable: key.stable, fingerprint: fingerprintOf(node.tag, sig), identity });
  }

  // Group by identity; assign a disambiguator only within multi-element groups.
  const byIdentity = new Map<string, Pre[]>();
  for (const p of pre) {
    if (!byIdentity.has(p.identity)) byIdentity.set(p.identity, []);
    byIdentity.get(p.identity)!.push(p);
  }

  const drafts: EntryDraft[] = [];
  for (const p of pre) {
    const group = byIdentity.get(p.identity)!;
    let disambiguator = '';
    if (group.length > 1) {
      disambiguator = disambiguate(p, group, warnings);
    }
    const sig = normalizeSignals(p.node.signals);
    drafts.push({
      id: formatId(config.idFormat, {
        component: p.node.component, element: p.short, key: slugify(p.identityKey), tag: p.node.tag, disambiguator,
      }),
      component: p.node.component,
      tag: p.node.tag,
      element_type: p.long,
      identity: p.identity,
      identity_key: slugify(p.identityKey),
      fingerprint: p.fingerprint,
      signals: sig,
      loc: p.node.loc,
    });
  }
  return { drafts, warnings };
}

/** Prefer a distinguishing stable token; else a positional index (1-based) + warning. */
function disambiguate(p: Pre, group: Pre[], warnings: Warning[]): string {
  const sig = normalizeSignals(p.node.signals);
  const stableToken = sig.html_id ?? sig.route ?? Object.values(sig.bound_identifiers)[0] ?? null;
  if (stableToken) {
    const distinct = new Set(group.map((g) => {
      const gs = normalizeSignals(g.node.signals);
      return gs.html_id ?? gs.route ?? Object.values(gs.bound_identifiers)[0] ?? '';
    }));
    if (distinct.size === group.length && stableToken) return slugify(stableToken);
  }
  const index = group.indexOf(p) + 1;
  warnings.push({
    code: 'positional-disambiguator', element_type: p.long, identity: p.identity,
    message: `${p.identity} has ${group.length} indistinguishable elements; using positional index ${index}. Add an explicit key for stable ids.`,
  });
  return index === 1 ? '' : String(index);
}
```

- [ ] **Step 4: Update `test/helpers.ts` `node` factory to use `signals`**

Replace the `node` function (keep `entry`/`snapshot`, updated in Task 7):

```ts
import { ElementNode } from '../src/core/types';

export function node(partial: Partial<ElementNode> & { tag: string }): ElementNode {
  return { component: 'login', signals: {}, ...partial };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/core/engine.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/engine.ts test/core/engine.test.ts test/helpers.ts
git commit -m "Rewrite engine: pure per-element ids, unique via disambiguation, warnings"
```

---

### Task 7: Registry entry shape

**Files:**
- Modify: `src/registry/storage.ts` (`RegistryEntry`)
- Modify: `test/helpers.ts` (`entry`)
- Test: covered via Task 8.

- [ ] **Step 1: Update `RegistryEntry` in `src/registry/storage.ts`**

Replace the `RegistryEntry` interface with:

```ts
import { NormalizedSignals } from '../core/types';

export interface RegistryEntry {
  component: string;
  tag: string;
  element_type: string;
  identity: string;
  fingerprint: string;
  signals: NormalizedSignals;
  source: 'generated' | 'manual';
  first_seen_version: number;
  last_seen_version: number;
  last_generated_at: string;
  generation_history: number[];
}
```

(Add the `import` at the top of the file alongside the existing `node:fs`/`node:path` imports. `RegistrySnapshot`, `RegistryStorage`, `InMemoryStorage`, `JsonFileStorage`, and the `retired` field are unchanged.)

- [ ] **Step 2: Update the `entry` helper in `test/helpers.ts`**

Replace the `entry` function:

```ts
import { RegistryEntry, RegistrySnapshot } from '../src/registry/storage';
import { normalizeSignals } from '../src/core/signals';

export function entry(partial: Partial<RegistryEntry> & { fingerprint: string }): RegistryEntry {
  return {
    component: 'login',
    tag: 'input',
    element_type: 'native_input_text',
    identity: 'login::input::x',
    signals: normalizeSignals({}),
    source: 'generated',
    first_seen_version: 1,
    last_seen_version: 1,
    last_generated_at: '2026-01-01T00:00:00.000Z',
    generation_history: [1],
    ...partial,
  };
}
```

(Keep `snapshot` unchanged.)

- [ ] **Step 3: Commit**

```bash
git add src/registry/storage.ts test/helpers.ts
git commit -m "Add identity + signals snapshot to RegistryEntry"
```

---

### Task 8: Reconcile drafts into entries

**Files:**
- Modify: `src/registry/registry.ts`
- Test: `test/registry/reconcile.test.ts` (update fixtures)

- [ ] **Step 1: Update `reconcile` entry construction in `src/registry/registry.ts`**

Change the import and the `entries[d.id]` assignment. Replace `import { EntryDraft } from '../core/types';` block's usage and the `toSemanticRecord` helper. Delete `toSemanticRecord`. Set the entry as:

```ts
entries[d.id] = {
  component: d.component,
  tag: d.tag,
  element_type: d.element_type,
  identity: d.identity,
  fingerprint: d.fingerprint,
  signals: d.signals,
  source,
  first_seen_version: existing?.first_seen_version ?? version,
  last_seen_version: version,
  last_generated_at: now,
  generation_history: history,
};
```

(The tombstone/`retired` carry-forward logic and the `existing = prevEntries[d.id] ?? prevRetired[d.id]` lookup from the prior fix are unchanged.)

- [ ] **Step 2: Update fixtures in `test/registry/reconcile.test.ts`**

The existing reconcile tests build drafts via `generate(...)`. Update them to read `.drafts` from the new return shape. At the top change:

```ts
const draftsFor = (...nodes: ReturnType<typeof node>[]) => generate(nodes, DEFAULT_CONFIG).drafts;
const emailInput = () => node({ tag: 'input', signals: { form_control: 'email', type: 'email' } });
const button = () => node({ tag: 'button', signals: { event_handlers: { click: 'go' }, text: 'x' } });
```

(Keep the rest of the tests; the asserted id `login__input--email` is unchanged because `form_control: 'email'` yields key `email`.)

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run test/registry/reconcile.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 4: Commit**

```bash
git add src/registry/registry.ts test/registry/reconcile.test.ts
git commit -m "Reconcile drafts into identity+signals registry entries"
```

---

### Task 9: Deterministic diff by identity + field-level modified

**Files:**
- Modify: `src/registry/diff.ts` (rewrite)
- Test: `test/registry/diff.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the test `test/registry/diff.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { diff } from '../../src/registry/diff';
import { snapshot, entry } from '../helpers';
import { normalizeSignals } from '../../src/core/signals';

const e = (id: string, identity: string, raw: Parameters<typeof normalizeSignals>[0], fp: string) =>
  entry({ identity, fingerprint: fp, signals: normalizeSignals(raw) });

describe('diff (exact identity match)', () => {
  it('unchanged when identity and fingerprint match', () => {
    const v1 = snapshot(1, { a: e('a', 'login::input::email', { form_control: 'email' }, 'F') });
    const v2 = snapshot(2, { a: e('a', 'login::input::email', { form_control: 'email' }, 'F') });
    expect(diff(v1, v2).summary.unchanged).toBe(1);
  });

  it('modified with a field-level change list when copy changes', () => {
    const v1 = snapshot(1, { b: e('b', 'login::button::login', { event_handlers: { click: 'go' }, text: 'Sign in' }, 'F1') });
    const v2 = snapshot(2, { b: e('b', 'login::button::login', { event_handlers: { click: 'go' }, text: 'Login' }, 'F2') });
    const d = diff(v1, v2);
    expect(d.summary.modified).toBe(1);
    expect(d.modified[0].changes).toContainEqual({ field: 'text', old: 'Sign in', new: 'Login' });
  });

  it('added / removed by identity, no fuzzy matching', () => {
    const v1 = snapshot(1, { gone: e('gone', 'login::a::old', { route: '/old' }, 'X') });
    const v2 = snapshot(2, { fresh: e('fresh', 'login::a::new', { route: '/new' }, 'Y') });
    const d = diff(v1, v2);
    expect(d.summary).toMatchObject({ added: 1, removed: 1 });
    expect(d.added[0].id).toBe('fresh');
    expect(d.removed[0].id).toBe('gone');
  });

  it('regenerated when an unmatched id has multi-version history', () => {
    const v1 = snapshot(1, { other: e('other', 'login::a::o', { route: '/o' }, 'A') });
    const v2 = snapshot(2, {
      other: e('other', 'login::a::o', { route: '/o' }, 'A'),
      reborn: entry({ identity: 'login::a::r', fingerprint: 'B', generation_history: [1, 2] }),
    });
    const d = diff(v1, v2);
    expect(d.summary.regenerated).toBe(1);
    expect(d.regenerated[0].id).toBe('reborn');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry/diff.test.ts`
Expected: FAIL — `diff` still matches by id key / has no field-level `changes`.

- [ ] **Step 3: Rewrite `src/registry/diff.ts`**

```ts
/**
 * Deterministic diff. Elements are matched across versions by their stable
 * `identity` (exact equality) — never by fuzzy similarity. A copy edit keeps
 * the same identity and surfaces as `modified` with the exact list of changed
 * fingerprint fields, so the element is still locatable and you only revisit a
 * test when an asserted field changed.
 */
import { RegistrySnapshot, RegistryEntry } from './storage';
import { NormalizedSignals } from '../core/types';

export interface SignalChange { field: string; old: string | null; new: string | null }
export interface ModifyEntry { id: string; identity: string; component: string; changes: SignalChange[] }
export interface SimpleEntry { id: string; identity: string; component: string }

export interface DiffResult {
  from_version: number;
  to_version: number;
  summary: { unchanged: number; added: number; removed: number; modified: number; regenerated: number };
  added: SimpleEntry[];
  removed: SimpleEntry[];
  modified: ModifyEntry[];
  regenerated: SimpleEntry[];
}

function scalarFields(s: NormalizedSignals): Record<string, string | null> {
  return {
    explicit_key: s.explicit_key, form_control: s.form_control, name: s.name, route: s.route,
    html_id: s.html_id, text: s.text, aria_label: s.aria_label, placeholder: s.placeholder,
    title: s.title, alt: s.alt, value: s.value, type: s.type, role: s.role,
  };
}

export function diffSignals(a: NormalizedSignals, b: NormalizedSignals): SignalChange[] {
  const af = scalarFields(a), bf = scalarFields(b);
  const changes: SignalChange[] = [];
  for (const field of Object.keys(af)) {
    if (af[field] !== bf[field]) changes.push({ field, old: af[field], new: bf[field] });
  }
  return changes;
}

function byIdentity(snap: RegistrySnapshot): Map<string, { id: string; entry: RegistryEntry }> {
  const m = new Map<string, { id: string; entry: RegistryEntry }>();
  for (const [id, entry] of Object.entries(snap.entries)) m.set(entry.identity, { id, entry });
  return m;
}

export function diff(from: RegistrySnapshot, to: RegistrySnapshot): DiffResult {
  const fromMap = byIdentity(from);
  const toMap = byIdentity(to);

  const added: SimpleEntry[] = [];
  const removed: SimpleEntry[] = [];
  const modified: ModifyEntry[] = [];
  const regenerated: SimpleEntry[] = [];
  let unchanged = 0;

  for (const [identity, { id, entry }] of toMap) {
    const prev = fromMap.get(identity);
    if (prev) {
      if (prev.entry.fingerprint === entry.fingerprint) unchanged++;
      else modified.push({ id, identity, component: entry.component, changes: diffSignals(prev.entry.signals, entry.signals) });
    } else if ((entry.generation_history?.length ?? 0) > 1) {
      regenerated.push({ id, identity, component: entry.component });
    } else {
      added.push({ id, identity, component: entry.component });
    }
  }
  for (const [identity, { id, entry }] of fromMap) {
    if (!toMap.has(identity)) removed.push({ id, identity, component: entry.component });
  }

  const cmp = (a: SimpleEntry, b: SimpleEntry) => a.id.localeCompare(b.id);
  added.sort(cmp); removed.sort(cmp); regenerated.sort(cmp);
  modified.sort((a, b) => a.id.localeCompare(b.id));

  return {
    from_version: from.version, to_version: to.version,
    summary: { unchanged, added: added.length, removed: removed.length, modified: modified.length, regenerated: regenerated.length },
    added, removed, modified, regenerated,
  };
}

export function diffToMarkdown(d: DiffResult): string {
  const L: string[] = [`# TestID Diff: v${d.from_version} -> v${d.to_version}`, '',
    '| Category | Count |', '| --- | ---: |'];
  for (const k of ['unchanged', 'added', 'removed', 'modified', 'regenerated'] as const) {
    L.push(`| ${k} | ${d.summary[k]} |`);
  }
  if (d.modified.length) {
    L.push('', '## Modified', '| ID | Changed fields |', '| --- | --- |');
    for (const m of d.modified) L.push(`| \`${m.id}\` | ${m.changes.map((c) => c.field).join(', ')} |`);
  }
  if (d.added.length) {
    L.push('', '## Added', '| ID |', '| --- |');
    for (const a of d.added) L.push(`| \`${a.id}\` |`);
  }
  if (d.removed.length) {
    L.push('', '## Removed', '| ID |', '| --- |');
    for (const r of d.removed) L.push(`| \`${r.id}\` |`);
  }
  return L.join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/registry/diff.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/diff.ts test/registry/diff.test.ts
git commit -m "Diff by exact identity with field-level modified reports"
```

---

### Task 10: Wire service, transport, http, cli to new shapes

**Files:**
- Modify: `src/server/service.ts` (`generate` returns `{drafts, warnings}`; expose warnings)
- Modify: `src/client/transport.ts` (no signature change; verify compiles)
- Modify: `src/server/http.ts` (no change beyond types; verify)
- Modify: `src/server/_reexport.ts` (no change; verify)
- Test: build + typecheck

- [ ] **Step 1: Update `TestIdService.tag` in `src/server/service.ts`**

Add `warnings` to `TagResponse` and use the new generate shape:

```ts
import { Warning } from '../core/types';
```

Add to `TagResponse`:

```ts
  warnings: Warning[];
```

Replace the `tag` body's draft line and return:

```ts
    const { drafts, warnings } = generate(req.nodes, config);
    const { snapshot, overrides } = await reconcile(drafts, this.storage);

    const edits: Edit[] = drafts
      .filter((d) => d.loc)
      .map((d) => ({ loc: d.loc!, attributeName: config.attributeName, id: d.id }));

    return {
      version: snapshot.version,
      assignments: drafts.map((d) => ({ fingerprint: d.fingerprint, id: d.id, component: d.component })),
      edits,
      overrides,
      warnings,
    };
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: errors only in adapters (`html.ts`/`vue.ts`/`sketches.ts`) and demos, which still use the old `semantic` shape. Core, registry, server, client compile.

- [ ] **Step 3: Commit**

```bash
git add src/server/service.ts
git commit -m "Thread identity warnings through the tag response"
```

---

### Task 11: HTML adapter emits RawSignals

**Files:**
- Modify: `src/adapters/html.ts`
- Test: `test/adapters/html.test.ts` (create)

- [ ] **Step 1: Write the failing test `test/adapters/html.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { HtmlTemplateAdapter } from '../../src/adapters/html';

const SRC = `<form>
  <input name="email" type="email" placeholder="you@x" aria-label="Email">
  <a routerlink="/forgot">Forgot?</a>
  <button type="submit">Sign in</button>
</form>`;

describe('HtmlTemplateAdapter.parse', () => {
  const nodes = new HtmlTemplateAdapter().parse(SRC, 'login.html', 'login');
  const byTag = (t: string) => nodes.find((n) => n.tag === t)!;

  it('maps name/type/placeholder/aria-label into signals', () => {
    expect(byTag('input').signals).toMatchObject({ name: 'email', type: 'email', placeholder: 'you@x', aria_label: 'Email' });
  });
  it('maps routerlink/href into route and captures text', () => {
    expect(byTag('a').signals.route).toBe('/forgot');
    expect(byTag('a').signals.text).toBe('Forgot?');
  });
  it('captures button text', () => {
    expect(byTag('button').signals.text).toBe('Sign in');
  });
});

describe('HtmlTemplateAdapter.write (idempotent)', () => {
  it('does not duplicate the attribute on re-run', () => {
    const a = new HtmlTemplateAdapter();
    const nodes = a.parse(SRC, 'login.html', 'login');
    const btn = nodes.find((n) => n.tag === 'button')!;
    const once = a.write(SRC, [{ loc: btn.loc!, attributeName: 'data-testid', id: 'login__button--login' }]);
    const btn2 = a.parse(once, 'login.html', 'login').find((n) => n.tag === 'button')!;
    const twice = a.write(once, [{ loc: btn2.loc!, attributeName: 'data-testid', id: 'login__button--login' }]);
    expect(twice).toBe(once);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/html.test.ts`
Expected: FAIL — parse still returns `.semantic`.

- [ ] **Step 3: Update `normalize` + `parse` in `src/adapters/html.ts`**

Replace the `normalize` function and the `nodes.push({...})` object. Change the import `import { ElementNode, SemanticHints } from '../core/types';` to `import { ElementNode, RawSignals } from '../core/types';`. Replace `normalize`:

```ts
function normalize(attrs: Record<string, string>): RawSignals {
  const get = (...names: string[]) => { for (const n of names) if (attrs[n] != null) return attrs[n]; return null; };
  return {
    explicit_key: get('data-tid'),
    form_control: get('formcontrolname', 'name'),
    name: get('name'),
    route: get('routerlink', 'to', 'href'),
    html_id: get('id'),
    aria_label: get('aria-label'),
    placeholder: get('placeholder'),
    type: get('type'),
    role: get('role'),
  };
}
```

In `parse`, replace the `const semantic = normalize(tag, attrs);` line and the text assignment + push with:

```ts
      const signals = normalize(attrs);
      if (text) signals.text = text;

      const tagEnd = m.index + m[0].length - 1;
      nodes.push({
        component, tag, signals,
        existingId: attrs['data-testid'] ?? attrs['data-cy'] ?? null,
        loc: { file, start: m.index, end: tagEnd },
      });
```

(The `write` method already uses `applyTestIdEdits` — unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/html.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/html.ts test/adapters/html.test.ts
git commit -m "HTML adapter emits RawSignals"
```

---

### Task 12: Vue adapter emits RawSignals (with code-wired extraction)

**Files:**
- Modify: `src/adapters/vue.ts`
- Test: `test/adapters/vue.test.ts` (update + extend)

- [ ] **Step 1: Extend the test `test/adapters/vue.test.ts`**

Replace the `parse` assertions block with signal-shaped expectations and add an event/bound test. Use this SFC and assertions:

```ts
const SFC = `<template>
  <v-form>
    <v-text-field v-model="email" type="email" placeholder="you@example.com" />
    <input name="password" type="password" aria-label="Password" />
    <router-link to="/forgot">Forgot password?</router-link>
    <v-btn type="submit" @click="login">Sign in</v-btn>
  </v-form>
</template>
<script setup>
import { ref } from 'vue';
const email = ref('');
function login() {}
</script>
`;

// inside describe('VueAdapter.parse'):
it('maps v-model to form_control and @click to event_handlers', () => {
  const tf = byTag(nodes, 'v-text-field');
  expect(tf.signals).toMatchObject({ form_control: 'email', type: 'email', placeholder: 'you@example.com' });
  const btn = byTag(nodes, 'v-btn');
  expect(btn.signals.event_handlers).toMatchObject({ click: 'login' });
});
it('maps router-link to and native name', () => {
  expect(byTag(nodes, 'router-link').signals.route).toBe('/forgot');
  expect(byTag(nodes, 'input').signals).toMatchObject({ name: 'password', aria_label: 'Password' });
});
```

(Keep the existing `write` and `VUETIFY_TAG_MAP` tests; the `parse(...)` call and `byTag` helper stay.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/vue.test.ts`
Expected: FAIL — parse returns `.semantic`; no `event_handlers`.

- [ ] **Step 3: Update `src/adapters/vue.ts` to emit `RawSignals`**

Change the import to `import { ElementNode, RawSignals } from '../core/types';`. Replace `readProps` and `normalize`:

```ts
function readProps(node: VueNode) {
  const attrs: Record<string, string> = {};
  const bound: Record<string, string> = {};
  const events: Record<string, string> = {};
  let model: string | null = null;
  for (const p of node.props ?? []) {
    if (p.type === PROP_ATTRIBUTE) attrs[p.name] = p.value?.content ?? '';
    else if (p.type === PROP_DIRECTIVE) {
      if (p.name === 'model') model = p.exp?.content ?? null;
      else if (p.name === 'bind' && p.arg?.content) bound[p.arg.content] = p.exp?.content ?? '';
      else if (p.name === 'on' && p.arg?.content) events[p.arg.content] = handlerName(p.exp?.content ?? '');
    }
  }
  return { attrs, bound, events, model };
}

/** Reduce a handler expression to a function name: "login" / "save()" -> "login"/"save". */
function handlerName(expr: string): string {
  const m = /^\s*([A-Za-z_$][\w$]*)\s*\(?/.exec(expr);
  return m ? m[1] : expr.trim();
}

function normalize(node: VueNode): RawSignals {
  const { attrs, bound, events, model } = readProps(node);
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (attrs[k] != null && attrs[k] !== '') return attrs[k];
      if (bound[k] != null && bound[k] !== '') return bound[k];
    }
    return null;
  };
  const signals: RawSignals = {
    explicit_key: pick('data-tid'),
    form_control: model ?? pick('name'),
    name: pick('name'),
    route: pick('to', 'href'),
    event_handlers: events,
    bound_identifiers: bound,
    html_id: pick('id'),
    aria_label: pick('aria-label'),
    placeholder: pick('placeholder'),
    type: pick('type'),
    role: pick('role'),
  };
  const text = directText(node);
  if (text) signals.text = text;
  return signals;
}
```

In `parse`, change `semantic: normalize(node)` to `signals: normalize(node)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/vue.test.ts`
Expected: PASS (all vue tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/vue.ts test/adapters/vue.test.ts
git commit -m "Vue adapter emits RawSignals incl event handlers and bound identifiers"
```

---

### Task 13: Update demos, sketches, full verification, and CLAUDE.md

**Files:**
- Modify: `examples/demo.ts`, `examples/vue-demo.ts` (no API change needed beyond confirming output)
- Modify: `src/adapters/sketches.ts` (`@ts-nocheck` Angular/React sketches: update to reference `signals`)
- Modify: `CLAUDE.md` at repo container (note new identity model + `retired`/`signals`)
- Test: full suite + demos

- [ ] **Step 1: Update the Angular/React sketches in `src/adapters/sketches.ts`**

The file is `@ts-nocheck`, so it will compile, but update the returned objects to the new shape for accuracy. Replace each `semantic: { ... } as Partial<SemanticHints>` with `signals: { ... } as RawSignals` and rename fields to RawSignals slots (`field_name`->`form_control`, add `event_handlers`/`bound_identifiers` where illustrative). Change the import to `import { ElementNode, RawSignals } from '../core/types';`.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — all core, registry, adapter tests green.

- [ ] **Step 3: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 4: Run both demos and confirm behavior**

Run: `npm run demo`
Expected: ids derive from stable keys; identical input -> identical id set: true.

Run: `npm run demo:vue`
Expected: `v-text-field` -> `login__input--email`; editing button text "Sign in"->"Login" shows the button id **unchanged** and a `modified` row listing `text` (no rename, no add/remove).

- [ ] **Step 5: Update `CLAUDE.md` (repo container, one level above the worktree)**

Add a short note under the architecture section: identity is now decoupled from fingerprint; `RawSignals` is the closed adapter contract; copy never drives identity; diff matches by exact identity with field-level `modified`; `RegistryEntry` stores `identity` + `signals`. Reference the spec at `docs/superpowers/specs/2026-06-09-stable-testid-identity-design.md`.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/sketches.ts examples/demo.ts examples/vue-demo.ts
git commit -m "Update sketches and demos to the RawSignals identity model"
```

(Commit the `CLAUDE.md` change separately since it lives outside the worktree and is untracked — note it to the user rather than committing if it is not in git.)

---

## Self-review

- **Spec coverage:** §4.1 closed schema → Task 1; §4.2 identity/fingerprint decouple → Tasks 2,3,6; §4.3 priority order → Task 2; §4.4 identity + uniqueness + disambiguation → Task 6 (registry-stable incumbent preservation explicitly deferred, noted in scope); §4.5 deterministic diff + field-level modified → Task 9; §4.6 enforcement (closed type + normalize/validate) → Task 1; §4.7 uniform adapters → Tasks 11,12; §4.8 safe workflow → out of scope (separate plan, noted). §6 migration (reset) → covered by Task 13 regeneration.
- **Placeholder scan:** no TBD/TODO; every code step contains full code.
- **Type consistency:** `RawSignals`/`NormalizedSignals` (Task 1) used in signals/identity/fingerprint/classify/engine/adapters; `generate` returns `{drafts, warnings}` (Task 6) consumed in service (Task 10) and reconcile tests (Task 8); `RegistryEntry.identity`/`signals` (Task 7) used by reconcile (Task 8) and diff (Task 9); `diff` `ModifyEntry.changes` (Task 9) asserted in Task 9 test and rendered in `diffToMarkdown`.
