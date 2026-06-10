import { describe, it, expect } from 'vitest';
import { VueAdapter, VUETIFY_TAG_MAP } from '../../src/adapters/vue';
import { ElementNode } from '../../src/core/types';

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

const byTag = (nodes: ElementNode[], tag: string) => nodes.find((n) => n.tag === tag)!;

describe('VueAdapter.parse', () => {
  const nodes = new VueAdapter().parse(SFC, 'Login.vue', 'login');

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

  it('captures button text', () => {
    expect(byTag(nodes, 'v-btn').signals.text).toBe('Sign in');
  });

  it('records SFC-absolute source locations and no pre-existing id', () => {
    const tf = byTag(nodes, 'v-text-field');
    expect(tf.loc).toBeDefined();
    expect(tf.loc!.file).toBe('Login.vue');
    expect(SFC.slice(tf.loc!.start, tf.loc!.start + 13)).toBe('<v-text-field');
    expect(tf.existingId ?? null).toBeNull();
  });
});

describe('VueAdapter.write', () => {
  const adapter = new VueAdapter();
  it('injects before the self-closing slash', () => {
    const tf = byTag(adapter.parse(SFC, 'Login.vue', 'login'), 'v-text-field');
    const out = adapter.write(SFC, [{ loc: tf.loc!, attributeName: 'data-testid', id: 'login__input--email' }]);
    expect(out).toContain('data-testid="login__input--email" />');
  });
  it('is idempotent', () => {
    const a = new VueAdapter();
    const btn = byTag(a.parse(SFC, 'Login.vue', 'login'), 'v-btn');
    const once = a.write(SFC, [{ loc: btn.loc!, attributeName: 'data-testid', id: 'login__button--login' }]);
    const btn2 = byTag(a.parse(once, 'Login.vue', 'login'), 'v-btn');
    const twice = a.write(once, [{ loc: btn2.loc!, attributeName: 'data-testid', id: 'login__button--login' }]);
    expect(twice).toBe(once);
  });
});

describe('VUETIFY_TAG_MAP', () => {
  it('classifies common Vuetify components to native-equivalent shorts', () => {
    expect(VUETIFY_TAG_MAP['v-text-field'].short).toBe('input');
    expect(VUETIFY_TAG_MAP['v-btn'].short).toBe('button');
  });
});

describe('VueAdapter.parse loop detection', () => {
  const SFC = `<template>
  <ul>
    <li v-for="x in items" :key="x.id">
      <button @click="pick(x)">Pick</button>
    </li>
  </ul>
</template>

<script setup>
function pick(x) { void x; }
</script>
`;
  const nodes = new VueAdapter().parse(SFC, 'List.vue', 'list');
  const by = (t: string) => nodes.find((n) => n.tag === t)!;

  it('marks the v-for element and its descendants as inLoop', () => {
    expect(by('li').inLoop).toBe(true);
    expect(by('button').inLoop).toBe(true);
  });

  it('leaves elements outside the loop unmarked', () => {
    expect(by('ul').inLoop ?? false).toBe(false);
  });
});

describe('VueAdapter.parse bound testid', () => {
  const SFC = `<template>
  <ul>
    <li v-for="u in users" :key="u.id" :data-testid="'user-row-' + u.id">
      <button @click="edit(u)" :data-testid="'user-edit-' + u.id">Edit</button>
      <button @click="remove(u)">Delete</button>
    </li>
  </ul>
</template>

<script setup>
function edit(u) { void u; }
function remove(u) { void u; }
</script>
`;
  const nodes = new VueAdapter().parse(SFC, 'List.vue', 'list');

  it('skips elements that already carry a bound :data-testid', () => {
    expect(nodes.some((n) => n.tag === 'li')).toBe(false);
    expect(nodes.filter((n) => n.tag === 'button')).toHaveLength(1); // only the unbound Delete button
  });

  it('still visits descendants of a skipped element', () => {
    const del = nodes.find((n) => n.tag === 'button')!;
    expect(del.signals.event_handlers).toMatchObject({ click: 'remove' });
    expect(del.inLoop).toBe(true);
  });
});

describe('VueAdapter.resolveSymbolDefs', () => {
  const SFC = `<template>
  <button @click="saveOrder">Save</button>
</template>

<script setup>
import { ref } from 'vue';
import { submit } from './api';
const email = ref('');
function saveOrder() {
  return submit(email.value);
}
</script>
`;
  const adapter = new VueAdapter();

  it('resolves a local function to its full definition text', () => {
    const defs = adapter.resolveSymbolDefs!(['saveOrder'], SFC, 'X.vue');
    expect(defs.saveOrder).toContain('function saveOrder()');
    expect(defs.saveOrder).toContain('submit(email.value)');
  });

  it('resolves a const binding to its declaration text', () => {
    const defs = adapter.resolveSymbolDefs!(['email'], SFC, 'X.vue');
    expect(defs.email).toBe("const email = ref('');");
  });

  it('resolves an imported name to its import statement only (L3 opaque boundary)', () => {
    const defs = adapter.resolveSymbolDefs!(['submit'], SFC, 'X.vue');
    expect(defs.submit).toBe("import { submit } from './api';");
  });

  it('returns null for template-local / unknown names', () => {
    const defs = adapter.resolveSymbolDefs!(['u', 'nope'], SFC, 'X.vue');
    expect(defs.u).toBeNull();
    expect(defs.nope).toBeNull();
  });

  it('returns all-null when there is no script setup', () => {
    const noScript = '<template><button @click="go">Go</button></template>';
    expect(adapter.resolveSymbolDefs!(['go'], noScript, 'Y.vue')).toEqual({ go: null });
  });

  it('resolves export-ed declarations (export function / export const)', () => {
    const sfc = `<template><button @click="saveOrder">S</button></template>
<script setup>
export const limit = 5;
export function saveOrder() { return limit; }
</script>
`;
    const defs = adapter.resolveSymbolDefs!(['saveOrder', 'limit'], sfc, 'E.vue');
    expect(defs.saveOrder).toContain('export function saveOrder()');
    expect(defs.limit).toBe('export const limit = 5;');
  });
});
