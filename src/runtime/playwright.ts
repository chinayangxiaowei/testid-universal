/**
 * Playwright fixture for exercised-id coverage — a ready-to-use wrapper around the
 * framework-agnostic recorder (`createTestIdRecorder`). Importing this module does
 * NOT pull in @playwright/test: you pass your own `test` object in, so the core
 * package stays dependency-free and this works with any Playwright version.
 *
 * Usage (e2e/fixtures.ts):
 *
 *   import { test as base } from '@playwright/test';
 *   import { createTestIdFixture } from 'testid-universal';
 *   export const test = createTestIdFixture(base); // honours TESTID_COVERAGE_FILE
 *
 * Then `import { test } from './fixtures'` in specs. Every `page.getByTestId(...)`
 * is recorded; on each test's teardown the ids are appended to a shared artifact
 * (safe across parallel workers). Feed it to the report:
 *
 *   TESTID_COVERAGE_FILE=.testids-runtime npx playwright test
 *   testid coverage --runtime .testids-runtime --tests e2e
 */
import { createTestIdRecorder } from './index';

/** A page-like object exposing getByTestId (Playwright's Page satisfies this). */
interface PageLike { getByTestId: (id: string, ...rest: any[]) => any }

/** Playwright's test.extend shape, kept structural so we never import the package. */
interface ExtendableTest<T> {
  extend(fixtures: {
    page: (args: { page: PageLike }, use: (page: PageLike) => Promise<void>) => Promise<void>;
  }): T;
}

export interface TestIdFixtureOptions {
  /** Artifact path. Defaults to env TESTID_COVERAGE_FILE, then `.testids-runtime`. */
  file?: string;
}

/**
 * Extend a Playwright `test` so its `page` records every getByTestId lookup and
 * flushes the distinct ids to the artifact on teardown. Returns the extended test.
 */
export function createTestIdFixture<T>(base: ExtendableTest<T>, options: TestIdFixtureOptions = {}): T {
  const file = options.file ?? process.env.TESTID_COVERAGE_FILE ?? '.testids-runtime';
  return base.extend({
    page: async ({ page }, use) => {
      const recorder = createTestIdRecorder();
      const wrapped = recorder.wrapPage(page);
      try {
        await use(wrapped);
      } finally {
        recorder.appendTo(file);
      }
    },
  });
}
