import { describe, it, expect } from 'vitest';
import { formatId } from '../../src/core/format';

const TPL = '{component}__{element}--{key}{hash:-}';

describe('formatId', () => {
  it('omits the hash separator entirely when there is no hash (the readable case)', () => {
    expect(formatId(TPL, { component: 'login', element: 'input', key: 'email', tag: 'input', hash: '' }))
      .toBe('login__input--email');
  });

  it('prefixes the hash with a dash when present (collision case)', () => {
    expect(formatId(TPL, { component: 'login', element: 'input', key: 'email', tag: 'input', hash: 'a1b2c3' }))
      .toBe('login__input--email-a1b2c3');
  });

  it('supports the {tag} and bare {hash} tokens', () => {
    expect(formatId('{tag}@{hash}', { component: 'c', element: 'e', key: 'k', tag: 'button', hash: 'ff' }))
      .toBe('button@ff');
  });

  it('replaces every occurrence of a token', () => {
    expect(formatId('{key}-{key}', { component: 'c', element: 'e', key: 'x', tag: 't', hash: '' }))
      .toBe('x-x');
  });
});
