import { describe, it, expect } from 'vitest';
import { generateConstants, constNameForId } from '../../src/locators';
import { snapshot, entry } from '../helpers';

describe('generateConstants', () => {
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
});
