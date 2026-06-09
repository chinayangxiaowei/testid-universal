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
