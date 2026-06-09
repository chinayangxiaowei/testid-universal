import { describe, it, expect } from 'vitest';
import { slugify } from '../../src/core/semantic';

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
