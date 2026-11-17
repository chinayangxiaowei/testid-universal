import { describe, it, expect } from 'vitest';
import { generateConstants, constNameForId } from '../../src/locators';
import { snapshot, entry } from '../helpers';

describe('generateConstants', () => {
  it('throws when two distinct ids map to the same constant name', () => {
    const snap = snapshot(1, {
      'a__my-widget--x': entry({ fingerprint: 'F', identity: 'a::my-widget::x' }),
      'a__my--widget-x': entry({ fingerprint: 'G', identity: 'a::my::widget-x' }),
    });
    expect(() => generateConstants(snap)).toThrow(/collide/);
  });

  it('emits a frozen testIds map of camelName -> id, sorted', () => {
    const snap = snapshot(1, {
      'login__button--login': entry({ fingerprint: 'F', identity: 'login::button::login' }),
      'login__input--email': entry({ fingerprint: 'G', identity: 'login::input::email' }),
    });
    const out = generateConstants(snap);
    expect(out).toContain("export const testIds = {");
    expect(out).toContain("loginButtonLogin: 'login__button--login',");
    expect(out).toContain("loginInputEmail: 'login__input--email',");
    expect(out).toContain('} as const;');
    expect(out.indexOf('loginButtonLogin')).toBeLessThan(out.indexOf('loginInputEmail'));
  });
});

describe('constNameForId', () => {
  it('is a stable camelCase identifier derived from the id', () => {
    expect(constNameForId('login__button--login')).toBe('loginButtonLogin');
  });

  it('prefixes tid when the name would start with a digit (valid TS identifier)', () => {
    expect(constNameForId('1page__input--email')).toBe('tid1pageInputEmail');
  });

  it('generateConstants output stays a valid identifier for leading-digit ids', () => {
    const snap = snapshot(1, {
      '1page__input--email': entry({ fingerprint: 'F', identity: '1page::input::email' }),
    });
    expect(generateConstants(snap)).toContain("tid1pageInputEmail: '1page__input--email',");
  });
});

// Downstream: a TS-only module (`as const`) dropped into a plain-JS project breaks it.
// The flavor follows the target file extension; .ts keeps today's output byte-for-byte.
import { parse as babelParse } from '@babel/parser';
import { constantsLangForPath } from '../../src/locators';

describe('generateConstants — JS / TS flavor', () => {
  const snap = snapshot(1, {
    'login__button--login': entry({ fingerprint: 'F', identity: 'login::button::login' }),
  });

  it('js flavor carries no TS syntax and parses as plain ES module JS', () => {
    const out = generateConstants(snap, { lang: 'js' });
    expect(out).not.toMatch(/as const/);
    expect(out).toContain("loginButtonLogin: 'login__button--login',");
    expect(() => babelParse(out, { sourceType: 'module' })).not.toThrow();
    expect(out).toContain('@type {const}'); // JSDoc const assertion keeps checkJs literal types
  });

  it('ts flavor (default) is unchanged', () => {
    expect(generateConstants(snap, { lang: 'ts' })).toBe(generateConstants(snap));
    expect(generateConstants(snap)).toContain('} as const;');
  });

  it('flavor is picked from the target extension', () => {
    for (const f of ['ids.js', 'a/b/ids.mjs', 'ids.cjs', 'ids.jsx']) expect(constantsLangForPath(f)).toBe('js');
    for (const f of ['ids.ts', 'ids.mts', 'ids.cts', 'ids.tsx']) expect(constantsLangForPath(f)).toBe('ts');
    expect(constantsLangForPath(undefined)).toBe('ts');
  });
});
