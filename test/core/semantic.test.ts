import { describe, it, expect } from 'vitest';
import { slugify, selectKey, keyFor } from '../../src/core/semantic';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { node } from '../helpers';

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('Sign in')).toBe('sign-in');
    expect(slugify('you@example.com')).toBe('you-example-com');
    expect(slugify('Forgot password?')).toBe('forgot-password');
  });

  it('trims leading/trailing separators and collapses runs', () => {
    expect(slugify('  --Hello   World!!  ')).toBe('hello-world');
  });
});

describe('selectKey', () => {
  it('returns the first non-empty hint following keyPriority order', () => {
    // DEFAULT keyPriority: aria_label > field_name > name > placeholder > text_content > route
    const n = node({ tag: 'input', semantic: { field_name: 'password', aria_label: 'Password' } });
    expect(selectKey(n, DEFAULT_CONFIG)).toBe('Password'); // aria_label wins over field_name
  });

  it('falls through to lower-priority hints when higher ones are absent', () => {
    const n = node({ tag: 'a', semantic: { text_content: 'Forgot password?', route: '/forgot' } });
    expect(selectKey(n, DEFAULT_CONFIG)).toBe('Forgot password?'); // text_content before route
  });

  it('falls back to the tag name when there is no usable semantic', () => {
    expect(selectKey(node({ tag: 'section', semantic: {} }), DEFAULT_CONFIG)).toBe('section');
  });
});

describe('keyFor', () => {
  it('slugifies the selected key', () => {
    const n = node({ tag: 'button', semantic: { text_content: 'Sign in' } });
    expect(keyFor(n, DEFAULT_CONFIG)).toBe('sign-in');
  });

  it('two elements differing only by higher-priority label can share a slug', () => {
    // password input v1 (field_name) and v2 (aria_label "Password") both slug to "password"
    const v1 = node({ tag: 'input', semantic: { field_name: 'password' } });
    const v2 = node({ tag: 'input', semantic: { field_name: 'password', aria_label: 'Password' } });
    expect(keyFor(v1, DEFAULT_CONFIG)).toBe('password');
    expect(keyFor(v2, DEFAULT_CONFIG)).toBe('password');
  });
});
