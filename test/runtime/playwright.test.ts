import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestIdFixture } from '../../src/runtime/playwright';

/** Minimal stand-in for Playwright's `test` object: captures the page fixture. */
function fakeBase() {
  const captured: any = {};
  return {
    extend(fixtures: any) { captured.page = fixtures.page; return captured; },
    _captured: captured,
  };
}

describe('createTestIdFixture (Playwright)', () => {
  it('wraps page.getByTestId, records lookups, and appends them on teardown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tidfx-'));
    const file = join(dir, 'runtime.txt');
    const base = fakeBase();
    const test = createTestIdFixture(base as any, { file });

    // Drive the captured page fixture like Playwright would.
    const looked: string[] = [];
    const fakePage = { getByTestId: (id: string) => { looked.push(id); return { id }; } };
    await test.page({ page: fakePage }, async (wrapped: any) => {
      wrapped.getByTestId('login__input--email');
      wrapped.getByTestId('login__button--submit');
    });

    expect(looked).toEqual(['login__input--email', 'login__button--submit']); // passthrough preserved
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n').sort())
      .toEqual(['login__button--submit', 'login__input--email']);
  });

  it('defaults the artifact path to the TESTID_COVERAGE_FILE env var', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tidfx-'));
    const file = join(dir, 'env-runtime.txt');
    process.env.TESTID_COVERAGE_FILE = file;
    try {
      const base = fakeBase();
      const test = createTestIdFixture(base as any);
      await test.page({ page: { getByTestId: (id: string) => ({ id }) } }, async (w: any) => {
        w.getByTestId('x__y--z');
      });
      expect(readFileSync(file, 'utf8').trim()).toBe('x__y--z');
    } finally {
      delete process.env.TESTID_COVERAGE_FILE;
    }
  });
});
