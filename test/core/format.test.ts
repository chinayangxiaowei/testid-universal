import { describe, it, expect } from 'vitest';
import { formatId } from '../../src/core/format';

const TPL = '{component}__{element}--{key}{disambiguator:--}';

describe('formatId', () => {
  it('omits the disambiguator separator when none is needed', () => {
    expect(formatId(TPL, { component: 'login', element: 'input', key: 'email', tag: 'input', disambiguator: '' }))
      .toBe('login__input--email');
  });
  it('prefixes the disambiguator with -- when present', () => {
    expect(formatId(TPL, { component: 'login', element: 'input', key: 'email', tag: 'input', disambiguator: '2' }))
      .toBe('login__input--email--2');
  });
  it('supports {tag} and bare {disambiguator}', () => {
    expect(formatId('{tag}@{disambiguator}', { component: 'c', element: 'e', key: 'k', tag: 'button', disambiguator: 'x' }))
      .toBe('button@x');
  });
});
