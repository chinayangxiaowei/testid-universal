import { describe, it, expect } from 'vitest';
import { fingerprintOf, hashOf } from '../../src/core/fingerprint';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { node } from '../helpers';

describe('fingerprintOf', () => {
  it('is deterministic for identical input', () => {
    const a = node({ tag: 'input', semantic: { field_name: 'email', type: 'email' } });
    const b = node({ tag: 'input', semantic: { field_name: 'email', type: 'email' } });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('is independent of the authoring order of semantic hints', () => {
    // FINGERPRINT_ORDER is fixed, so insertion order must not change the signature.
    const a = node({ tag: 'input', semantic: { type: 'email', field_name: 'email', placeholder: 'you@x' } });
    const b = node({ tag: 'input', semantic: { placeholder: 'you@x', field_name: 'email', type: 'email' } });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('changes when a semantic hint changes (drives "modified" detection)', () => {
    const before = node({ tag: 'input', semantic: { field_name: 'password', type: 'password' } });
    const after = node({ tag: 'input', semantic: { field_name: 'password', type: 'password', aria_label: 'Password' } });
    expect(fingerprintOf(before)).not.toBe(fingerprintOf(after));
  });

  it('ignores empty / whitespace-only hint values', () => {
    const withEmpty = node({ tag: 'input', semantic: { field_name: 'email', placeholder: '   ', name: '' } });
    const without = node({ tag: 'input', semantic: { field_name: 'email' } });
    expect(fingerprintOf(withEmpty)).toBe(fingerprintOf(without));
  });

  it('folds extraAttrs in a stable (sorted) order', () => {
    const a = node({ tag: 'div', semantic: { name: 'x' }, extraAttrs: { b: '2', a: '1' } });
    const b = node({ tag: 'div', semantic: { name: 'x' }, extraAttrs: { a: '1', b: '2' } });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('starts the signature with the tag name', () => {
    expect(fingerprintOf(node({ tag: 'button', semantic: { text_content: 'Go' } }))).toMatch(/^button\|/);
  });
});

describe('hashOf', () => {
  it('is deterministic', () => {
    const fp = 'input|type=email|field_name=email';
    expect(hashOf(fp, DEFAULT_CONFIG)).toBe(hashOf(fp, DEFAULT_CONFIG));
  });

  it('honors hashLength clamped to [4, 16]', () => {
    const fp = 'whatever';
    expect(hashOf(fp, { ...DEFAULT_CONFIG, hashLength: 6 })).toHaveLength(6);
    expect(hashOf(fp, { ...DEFAULT_CONFIG, hashLength: 1 })).toHaveLength(4); // clamped up
    expect(hashOf(fp, { ...DEFAULT_CONFIG, hashLength: 99 })).toHaveLength(16); // clamped down
  });

  it('produces different hashes for different fingerprints', () => {
    expect(hashOf('a', DEFAULT_CONFIG)).not.toBe(hashOf('b', DEFAULT_CONFIG));
  });
});
