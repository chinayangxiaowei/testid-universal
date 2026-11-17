/**
 * Locator generation — turn a registry snapshot into ready-to-use selectors for
 * each test stack. Pure, framework-agnostic: it only reads ids + the attribute
 * name, never the source templates.
 *
 * Adding a new test stack = adding one branch here. The selector convention is
 * always `[<attr>="<id>"]`, so locators stay valid as long as the attribute the
 * adapter wrote matches the one requested.
 */
import { RegistrySnapshot } from '../registry/storage';

export type LocatorTarget = 'robot' | 'playwright' | 'cypress' | 'webdriverio' | 'selenium-python' | 'testcafe';

const DEFAULT_ATTR = 'data-testid';

/** A SCREAMING_SNAKE identifier safe for variable names. */
function constName(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'EL';
}

/** A camelCase identifier safe for object keys / function names. */
function camelName(id: string): string {
  const parts = id.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'el';
  const name = parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join('');
  // A leading digit would make the emitted constant an invalid identifier.
  return /^[0-9]/.test(name) ? `tid${name}` : name;
}

function sortedIds(snapshot: RegistrySnapshot): string[] {
  return Object.keys(snapshot.entries).sort();
}

function robot(snapshot: RegistrySnapshot, attr: string): string {
  const lines = ['*** Variables ***'];
  for (const id of sortedIds(snapshot)) {
    lines.push(`\${${constName(id)}}    css=[${attr}="${id}"]`);
  }
  return lines.join('\n') + '\n';
}

function playwright(snapshot: RegistrySnapshot, attr: string): string {
  const lines = [
    '// Auto-generated Playwright locators. Do not edit by hand.',
    "import type { Page, Locator } from '@playwright/test';",
  ];
  if (attr !== DEFAULT_ATTR) {
    lines.push(`// Requires playwright.config: use: { testIdAttribute: '${attr}' }`);
  }
  lines.push('', 'export const testIds = {');
  for (const id of sortedIds(snapshot)) lines.push(`  ${camelName(id)}: '${id}',`);
  lines.push('} as const;', '');
  lines.push('export const locators = (page: Page): Record<string, Locator> => ({');
  for (const id of sortedIds(snapshot)) {
    lines.push(`  ${camelName(id)}: page.getByTestId(testIds.${camelName(id)}),`);
  }
  lines.push('});', '');
  return lines.join('\n');
}

function webdriverio(snapshot: RegistrySnapshot, attr: string): string {
  const lines = ['// Auto-generated WebdriverIO locators. Do not edit by hand.', '', 'export const testIds = {'];
  for (const id of sortedIds(snapshot)) lines.push(`  ${camelName(id)}: '${id}',`);
  lines.push('} as const;', '');
  lines.push('export const locators = {');
  for (const id of sortedIds(snapshot)) {
    lines.push(`  ${camelName(id)}: () => $(\`[${attr}="\${testIds.${camelName(id)}}"]\`),`);
  }
  lines.push('};', '');
  return lines.join('\n');
}

function seleniumPython(snapshot: RegistrySnapshot, attr: string): string {
  const lines = [
    '# Auto-generated Selenium locators. Do not edit by hand.',
    'from selenium.webdriver.common.by import By',
    '',
  ];
  for (const id of sortedIds(snapshot)) {
    lines.push(`${constName(id)} = (By.CSS_SELECTOR, '[${attr}="${id}"]')`);
  }
  return lines.join('\n') + '\n';
}

function testcafe(snapshot: RegistrySnapshot, attr: string): string {
  const lines = [
    '// Auto-generated TestCafe selectors. Do not edit by hand.',
    "import { Selector } from 'testcafe';",
    '',
    'export const testIds = {',
  ];
  for (const id of sortedIds(snapshot)) lines.push(`  ${camelName(id)}: '${id}',`);
  lines.push('};', '');
  for (const id of sortedIds(snapshot)) {
    lines.push(`export const ${camelName(id)} = Selector('[${attr}="${id}"]');`);
  }
  lines.push('');
  return lines.join('\n');
}

function cypress(snapshot: RegistrySnapshot, attr: string): string {
  const lines = ['// Auto-generated Cypress locators. Do not edit by hand.', '', 'export const testIds = {'];
  for (const id of sortedIds(snapshot)) lines.push(`  ${camelName(id)}: '${id}',`);
  lines.push('} as const;', '');
  for (const id of sortedIds(snapshot)) {
    lines.push(`export const get${constName(id).split('_').map((p) => p.charAt(0) + p.slice(1).toLowerCase()).join('')} = () => cy.get('[${attr}="${id}"]');`);
  }
  lines.push('');
  return lines.join('\n');
}

const FILENAME: Record<LocatorTarget, string> = {
  robot: 'testids.resource',
  playwright: 'testids.locators.ts',
  cypress: 'testids.locators.js',
  webdriverio: 'testids.locators.ts',
  'selenium-python': 'testids.py',
  testcafe: 'testids.locators.js',
};

/** Generate locator file(s) for a target. Returns { filename: content }. */
export function generateLocators(
  snapshot: RegistrySnapshot,
  target: LocatorTarget,
  attributeName: string = DEFAULT_ATTR,
): Record<string, string> {
  const attr = attributeName || DEFAULT_ATTR;
  let content: string;
  switch (target) {
    case 'robot': content = robot(snapshot, attr); break;
    case 'playwright': content = playwright(snapshot, attr); break;
    case 'cypress': content = cypress(snapshot, attr); break;
    case 'webdriverio': content = webdriverio(snapshot, attr); break;
    case 'selenium-python': content = seleniumPython(snapshot, attr); break;
    case 'testcafe': content = testcafe(snapshot, attr); break;
    default: throw new Error(`unknown locator target: ${target as string}`);
  }
  return { [FILENAME[target]]: content };
}

/**
 * Tolerant wrapper used by the backend service: defaults the attribute, validates
 * the target, and returns an empty map (rather than throwing) for an empty
 * registry — keeping the REST/transport surface forgiving.
 */
export function generateLocatorsSafe(
  snapshot: RegistrySnapshot,
  target: LocatorTarget,
  attributeName?: string,
): Record<string, string> {
  if (!FILENAME[target]) return {};
  if (Object.keys(snapshot.entries).length === 0) return { [FILENAME[target]]: '' };
  return generateLocators(snapshot, target, attributeName);
}

/** The camelCase constant name a test would import for this id (e.g. `loginButtonLogin`). */
export function constNameForId(id: string): string {
  return camelName(id);
}

/**
 * Emit a framework-agnostic constants module. Tests import these instead of
 * hardcoding id strings, so a removed/renamed id makes the constant vanish and
 * the test fails to compile (fail-closed).
 */
export type ConstantsLang = 'ts' | 'js';

/** Pick the constants flavor from the target file: .js/.mjs/.cjs/.jsx -> plain JS, else TS. */
export function constantsLangForPath(file: string | undefined): ConstantsLang {
  return file && /\.(m|c)?jsx?$/i.test(file) ? 'js' : 'ts';
}

export function generateConstants(snapshot: RegistrySnapshot, opts: { lang?: ConstantsLang } = {}): string {
  const js = opts.lang === 'js';
  // Plain JS gets the JSDoc const assertion (checkJs keeps literal types) instead of `as const`.
  const lines = ['// Auto-generated testid constants. Do not edit by hand.', '',
    js ? 'export const testIds = /** @type {const} */ ({' : 'export const testIds = {'];
  const seen = new Map<string, string>();
  for (const id of sortedIds(snapshot)) {
    const name = camelName(id);
    const prior = seen.get(name);
    if (prior) {
      throw new Error(
        `testId constant name "${name}" collides for ids "${prior}" and "${id}"; ` +
        `give one element an explicit key (data-tid) to disambiguate.`,
      );
    }
    seen.set(name, id);
    lines.push(`  ${name}: '${id}',`);
  }
  lines.push(js ? '});' : '} as const;', '');
  return lines.join('\n');
}
