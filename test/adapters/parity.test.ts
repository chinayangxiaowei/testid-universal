/**
 * Cross-adapter signal parity: the same semantic markup expressed in each
 * framework's vocabulary must produce the same identity key. This is the
 * audit gate for the closed RawSignals contract — an adapter that maps a
 * concept into a different slot (or misses a binding form) fails here.
 */
import { describe, it, expect } from 'vitest';
import { VueAdapter } from '../../src/adapters/vue';
import { AngularAdapter } from '../../src/adapters/angular';
import { ReactAdapter } from '../../src/adapters/react';
import { normalizeSignals } from '../../src/core/signals';
import { selectIdentityKey } from '../../src/core/identity';

function vueKey(tpl: string, tag: string) {
  const nodes = new VueAdapter().parse(`<template>${tpl}</template>`, 'A.vue', 'A');
  const n = nodes.find((x) => x.tag === tag)!;
  return selectIdentityKey(normalizeSignals(n.signals), tag);
}
function ngKey(tpl: string, tag: string) {
  const nodes = new AngularAdapter().parse(tpl, 'a.component.html', 'a');
  const n = nodes.find((x) => x.tag === tag)!;
  return selectIdentityKey(normalizeSignals(n.signals), tag);
}
function reactKey(src: string, tag: string) {
  const nodes = new ReactAdapter().parse(src, 'A.tsx', 'A');
  const n = nodes.find((x) => x.tag === tag)!;
  return selectIdentityKey(normalizeSignals(n.signals), tag);
}

describe('cross-adapter identity parity', () => {
  it('event handler keys agree', () => {
    const v = vueKey('<button @click="save">S</button>', 'button');
    const a = ngKey('<button (click)="save()">S</button>', 'button');
    const r = reactKey('<button onClick={save}>S</button>', 'button');
    expect([a.value, r.value]).toEqual([v.value, v.value]);
    expect(v.value).toBe('save');
  });

  it('bound form-control keys agree (binding form, not just static)', () => {
    const v = vueKey('<input v-model="email" />', 'input');
    const a = ngKey('<input [formControlName]="email" />', 'input');
    expect(a.source).toBe(v.source);
    expect(a.value).toBe('email');
  });

  it('bound name feeds the name slot in every adapter', () => {
    const v = vueKey('<input :name="field" />', 'input');
    const a = ngKey('<input [name]="field" />', 'input');
    const r = reactKey('<input name={field} />', 'input');
    expect([a.source, r.source]).toEqual([v.source, v.source]);
    expect([a.value, r.value]).toEqual([v.value, v.value]);
  });

  it('bound href feeds route in every adapter', () => {
    const v = vueKey('<a :href="docsUrl">Docs</a>', 'a');
    const a = ngKey('<a [href]="docsUrl">Docs</a>', 'a');
    const r = reactKey('<a href={docsUrl}>Docs</a>', 'a');
    expect([a.source, r.source]).toEqual([v.source, v.source]);
    expect(v.source).toBe('route');
  });

  it('bound aria-label is identity-visible in every adapter', () => {
    const v = vueKey('<button :aria-label="closeLabel"></button>', 'button');
    const a = ngKey('<button [attr.aria-label]="closeLabel"></button>', 'button');
    const r = reactKey('<button aria-label={closeLabel}></button>', 'button');
    expect([a.value, r.value]).toEqual([v.value, v.value]);
  });

  it('explicit_key accepts literals ONLY — a bound data-tid is not an explicit key', () => {
    const v = vueKey('<button :data-tid="dynamicKey" @click="save">S</button>', 'button');
    const a = ngKey('<button [attr.data-tid]="dynamicKey" (click)="save()">S</button>', 'button');
    const r = reactKey('<button data-tid={dynamicKey} onClick={save}>S</button>', 'button');
    for (const k of [v, a, r]) {
      expect(k.source).not.toBe('explicit_key');
      expect(k.value).toBe('save');
    }
    expect(vueKey('<button data-tid="ok">S</button>', 'button').source).toBe('explicit_key');
  });
});

describe('coverage denominator inputs (adapter-fed)', () => {
  it('a static tabindex reaches static_attributes in every adapter (isInteractive depends on it)', () => {
    const v = new VueAdapter().parse('<template><div tabindex="0">x</div></template>', 'A.vue', 'A')[0];
    const a = new AngularAdapter().parse('<div tabindex="0">x</div>', 'a.component.html', 'a')[0];
    const r = new ReactAdapter().parse('<div tabIndex="0">x</div>', 'A.tsx', 'A')[0];
    for (const n of [v, a, r]) {
      expect(normalizeSignals(n.signals).static_attributes['tabindex']).toBe('0');
    }
  });
});
