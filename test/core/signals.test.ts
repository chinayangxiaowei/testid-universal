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
