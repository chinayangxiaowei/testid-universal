import { describe, it, expect } from 'vitest';
import { referencedSymbolNames, hashSymbolSources } from '../../src/core/sourcedeps';
import { normalizeSignals } from '../../src/core/signals';

describe('referencedSymbolNames', () => {
  it('collects handler names, bound-identifier roots, and the form_control root', () => {
    const sig = normalizeSignals({
      event_handlers: { click: 'saveOrder', blur: 'onBlur' },
      bound_identifiers: { data: 'order.customer.name', items: 'rows' },
      form_control: 'form.email',
    });
    expect(referencedSymbolNames(sig)).toEqual(['form', 'onBlur', 'order', 'rows', 'saveOrder']);
  });

  it('returns an empty list when no code-wired signals exist', () => {
    expect(referencedSymbolNames(normalizeSignals({ text: 'Save' }))).toEqual([]);
  });
});

describe('hashSymbolSources', () => {
  it('hashes definition text and skips unresolved (null) entries', () => {
    const defs = hashSymbolSources({ saveOrder: 'function saveOrder() { return 1; }', gone: null });
    expect(Object.keys(defs)).toEqual(['saveOrder']);
    expect(defs.saveOrder).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is whitespace-insensitive but comment-sensitive (safe over-flag)', () => {
    const a = hashSymbolSources({ f: 'function f() {\n  return 1;\n}' });
    const b = hashSymbolSources({ f: 'function f() { return 1; }' });
    const c = hashSymbolSources({ f: 'function f() { return 1; } // changed' });
    expect(a.f).toBe(b.f);
    expect(c.f).not.toBe(b.f);
  });

  it('changes when the definition body changes', () => {
    const a = hashSymbolSources({ f: 'function f() { return 1; }' });
    const b = hashSymbolSources({ f: 'function f() { return 2; }' });
    expect(a.f).not.toBe(b.f);
  });
});
