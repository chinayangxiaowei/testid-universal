import { describe, it, expect } from 'vitest';
import { buildTestMap, buildTestMapForIds } from '../../src/testmap';
import { snapshot, entry } from '../helpers';

const snap = snapshot(1, {
  'login__button--login': entry({ fingerprint: 'F', identity: 'login::button::login' }),
  'login__input--email': entry({ fingerprint: 'G', identity: 'login::input::email' }),
});

describe('buildTestMap', () => {
  it('maps an id to a test that references its generated constant', () => {
    const map = buildTestMap([
      { file: 'a.spec.ts', source: 'await page.getByTestId(testIds.loginButtonLogin).click();' },
    ], snap);
    expect(map['login__button--login']).toEqual(['a.spec.ts']);
    expect(map['login__input--email']).toBeUndefined();
  });

  it('also matches a raw id string literal', () => {
    const map = buildTestMap([
      { file: 'b.spec.ts', source: `cy.get('[data-testid="login__input--email"]')` },
    ], snap);
    expect(map['login__input--email']).toEqual(['b.spec.ts']);
  });

  it('lists every test file that references the same id', () => {
    const map = buildTestMap([
      { file: 'a.spec.ts', source: 'testIds.loginButtonLogin' },
      { file: 'c.spec.ts', source: "'login__button--login'" },
    ], snap);
    expect(map['login__button--login'].sort()).toEqual(['a.spec.ts', 'c.spec.ts']);
  });
});

describe('buildTestMapForIds', () => {
  it('maps over an explicit id list (covers ids absent from any one snapshot, e.g. removed)', () => {
    const map = buildTestMapForIds(
      [{ file: 'a.spec.ts', source: 'page.getByTestId(testIds.goneButtonX)' }],
      ['gone__button--x'],
    );
    expect(map['gone__button--x']).toEqual(['a.spec.ts']);
  });
});
