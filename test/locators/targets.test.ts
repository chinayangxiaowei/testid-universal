import { describe, it, expect } from 'vitest';
import { generateLocators, LocatorTarget } from '../../src/locators';
import { snapshot, entry } from '../helpers';

const SNAP = snapshot(1, {
  'login__input--email': entry({ fingerprint: 'f1' }),
  'login__button--submit': entry({ fingerprint: 'f2', tag: 'button', element_type: 'native_button' }),
});

function fileOf(target: LocatorTarget): [string, string] {
  const files = generateLocators(SNAP, target);
  const [name] = Object.keys(files);
  return [name, files[name]];
}

describe('generateLocators targets', () => {
  it('playwright emits getByTestId helpers (modern idiom) plus the constants', () => {
    const [name, content] = fileOf('playwright');
    expect(name).toBe('testids.locators.ts');
    expect(content).toContain("loginInputEmail: 'login__input--email',");
    expect(content).toContain("page.getByTestId(testIds.loginInputEmail)");
    expect(content).not.toContain("page.locator('[data-testid=");
  });

  it('webdriverio emits $-helpers over the css attribute selector', () => {
    const [name, content] = fileOf('webdriverio');
    expect(name).toBe('testids.locators.ts');
    expect(content).toContain("loginInputEmail: 'login__input--email',");
    expect(content).toContain('$(`[data-testid="${testIds.loginInputEmail}"]`)');
  });

  it('selenium-python emits a python module with By.CSS_SELECTOR tuples', () => {
    const [name, content] = fileOf('selenium-python');
    expect(name).toBe('testids.py');
    expect(content).toContain('from selenium.webdriver.common.by import By');
    expect(content).toContain('LOGIN_INPUT_EMAIL = (By.CSS_SELECTOR, \'[data-testid="login__input--email"]\')');
  });

  it('testcafe emits Selector helpers', () => {
    const [name, content] = fileOf('testcafe');
    expect(name).toBe('testids.locators.js');
    expect(content).toContain("import { Selector } from 'testcafe';");
    expect(content).toContain('Selector(\'[data-testid="login__button--submit"]\')');
  });

  it('robot and cypress formats stay intact', () => {
    expect(fileOf('robot')[1]).toContain('${LOGIN_INPUT_EMAIL}    css=[data-testid="login__input--email"]');
    expect(fileOf('cypress')[1]).toContain('cy.get(\'[data-testid="login__input--email"]\')');
  });

  it('a non-default attribute flows through every target', () => {
    for (const t of ['webdriverio', 'selenium-python', 'testcafe'] as LocatorTarget[]) {
      const files = generateLocators(SNAP, t, 'data-cy');
      expect(Object.values(files)[0]).toContain('data-cy');
    }
    const pw = Object.values(generateLocators(SNAP, 'playwright', 'data-cy'))[0];
    expect(pw).toContain("testIdAttribute: 'data-cy'");
  });
});
