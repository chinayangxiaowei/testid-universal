import { describe, it, expect } from 'vitest';
import { buildTestCaseMapForIds, buildTestMapForIds, affectedTestCases, affectedTestCasesToMarkdown } from '../../src/testmap';

const SPEC = `import { test, expect } from '@playwright/test';
import { testIds } from './testids.generated';

test('login works', async ({ page }) => {
  await page.getByTestId(testIds.loginInputEmail).fill('a@b.c');
  await page.getByTestId(testIds.loginButtonSubmit).click();
});

test.describe('settings', () => {
  it('updates profile', async ({ page }) => {
    await page.getByTestId(testIds.settingsInputBio).fill('hi');
  });
  it('logs out', async ({ page }) => {
    await page.getByTestId('settings__button--logout').click();
  });
});
`;

const files = [{ file: 'e2e/app.spec.ts', source: SPEC }];

describe('buildTestCaseMapForIds', () => {
  it('maps each id to the enclosing test block, not just the file', () => {
    const m = buildTestCaseMapForIds(files, [
      'login__input--email', 'login__button--submit', 'settings__input--bio', 'settings__button--logout',
    ]);
    // camelCase: loginInputEmail <- login__input--email
    expect(m['login__input--email']).toEqual([{ file: 'e2e/app.spec.ts', test: 'login works' }]);
    expect(m['settings__input--bio']).toEqual([{ file: 'e2e/app.spec.ts', test: 'updates profile' }]);
    expect(m['settings__button--logout']).toEqual([{ file: 'e2e/app.spec.ts', test: 'logs out' }]);
  });

  it('handles a raw id string the same way as a constant reference', () => {
    const m = buildTestCaseMapForIds(files, ['settings__button--logout']);
    expect(m['settings__button--logout'][0].test).toBe('logs out');
  });

  it('buildTestMapForIds still returns deduped file lists (back-compat)', () => {
    const m = buildTestMapForIds(files, ['login__input--email', 'login__button--submit']);
    expect(m['login__input--email']).toEqual(['e2e/app.spec.ts']);
    expect(m['login__button--submit']).toEqual(['e2e/app.spec.ts']);
  });
});

describe('affectedTestCases', () => {
  it('routes a modified id to the specific test case', () => {
    const diff = { added: [], removed: [], modified: [{ id: 'settings__input--bio' } as any], regenerated: [], unchanged: [] } as any;
    const caseMap = buildTestCaseMapForIds(files, ['settings__input--bio']);
    const aff = affectedTestCases(diff, caseMap);
    expect(aff).toEqual([{ id: 'settings__input--bio', action: 're-test', tests: [{ file: 'e2e/app.spec.ts', test: 'updates profile' }] }]);
  });

  it('markdown shows file::test', () => {
    const diff = { added: [], removed: [], modified: [{ id: 'settings__input--bio' } as any], regenerated: [], unchanged: [] } as any;
    const md = affectedTestCasesToMarkdown(affectedTestCases(diff, buildTestCaseMapForIds(files, ['settings__input--bio'])));
    expect(md).toContain('e2e/app.spec.ts::updates profile');
  });
});
