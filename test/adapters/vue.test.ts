import { describe, it, expect } from 'vitest';
import { VueAdapter, VUETIFY_TAG_MAP } from '../../src/adapters/vue';
import { ElementNode } from '../../src/core/types';

const SFC = `<template>
  <v-form>
    <v-text-field v-model="email" type="email" placeholder="you@example.com" />
    <input name="password" type="password" aria-label="Password" />
    <router-link to="/forgot">Forgot password?</router-link>
    <v-btn type="submit">Sign in</v-btn>
  </v-form>
</template>

<script setup>
import { ref } from 'vue';
const email = ref('');
</script>
`;

const byTag = (nodes: ElementNode[], tag: string) => nodes.find((n) => n.tag === tag)!;

describe('VueAdapter.parse', () => {
  const nodes = new VueAdapter().parse(SFC, 'Login.vue', 'login');

  it('maps v-model and static attributes onto canonical hints', () => {
    const tf = byTag(nodes, 'v-text-field');
    expect(tf.semantic).toMatchObject({
      field_name: 'email',
      type: 'email',
      placeholder: 'you@example.com',
    });
  });

  it('maps a native name + aria-label', () => {
    const input = byTag(nodes, 'input');
    expect(input.semantic).toMatchObject({ field_name: 'password', name: 'password', aria_label: 'Password', type: 'password' });
  });

  it('maps router-link "to" onto route and captures text', () => {
    const link = byTag(nodes, 'router-link');
    expect(link.semantic.route).toBe('/forgot');
    expect(link.semantic.text_content).toBe('Forgot password?');
  });

  it('captures button text content', () => {
    expect(byTag(nodes, 'v-btn').semantic.text_content).toBe('Sign in');
  });

  it('records SFC-absolute source locations and no pre-existing id', () => {
    const tf = byTag(nodes, 'v-text-field');
    expect(tf.loc).toBeDefined();
    expect(tf.loc!.file).toBe('Login.vue');
    expect(SFC.slice(tf.loc!.start, tf.loc!.start + 13)).toBe('<v-text-field');
    expect(tf.existingId ?? null).toBeNull();
  });

  it('does not crash on the SFC script block and ignores it', () => {
    expect(nodes.every((n) => n.tag !== 'script')).toBe(true);
  });
});

describe('VueAdapter.write', () => {
  const adapter = new VueAdapter();

  it('injects the attribute inside a normal opening tag', () => {
    const btn = byTag(adapter.parse(SFC, 'Login.vue', 'login'), 'v-btn');
    const out = adapter.write(SFC, [{ loc: btn.loc!, attributeName: 'data-testid', id: 'login__button--sign-in' }]);
    expect(out).toContain('<v-btn type="submit" data-testid="login__button--sign-in">');
  });

  it('injects before the self-closing slash', () => {
    const tf = byTag(adapter.parse(SFC, 'Login.vue', 'login'), 'v-text-field');
    const out = adapter.write(SFC, [{ loc: tf.loc!, attributeName: 'data-testid', id: 'login__input--email' }]);
    expect(out).toContain('data-testid="login__input--email" />');
  });

  it('is idempotent: re-tagging an already-tagged file yields identical output', () => {
    const btn = byTag(adapter.parse(SFC, 'Login.vue', 'login'), 'v-btn');
    const once = adapter.write(SFC, [{ loc: btn.loc!, attributeName: 'data-testid', id: 'login__button--sign-in' }]);

    const btn2 = byTag(adapter.parse(once, 'Login.vue', 'login'), 'v-btn');
    const twice = adapter.write(once, [{ loc: btn2.loc!, attributeName: 'data-testid', id: 'login__button--sign-in' }]);
    expect(twice).toBe(once);
  });
});

describe('VUETIFY_TAG_MAP', () => {
  it('classifies common Vuetify components to native-equivalent shorts', () => {
    expect(VUETIFY_TAG_MAP['v-text-field'].short).toBe('input');
    expect(VUETIFY_TAG_MAP['v-btn'].short).toBe('button');
  });
});
