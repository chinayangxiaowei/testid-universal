/**
 * Runtime "exercised" coverage (Cypress-UI-Coverage-informed, zero infrastructure).
 *
 * Static coverage counts an id as covered when a test REFERENCES it; this layer
 * upgrades the metric to EXERCISED: which ids the suite actually looked up at run
 * time. Framework-agnostic by design — no @playwright/test import; the recorder
 * wraps any page-like object exposing `getByTestId`. Multiple workers append to a
 * shared line-based artifact; `coverage --runtime <file>` merges it into the report
 * (and surfaces dynamic bound ids the static registry can never see).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export interface TestIdRecorder {
  /** Wrap a page-like object so every getByTestId lookup is recorded (passthrough). */
  wrapPage<T extends { getByTestId: (id: string, ...rest: any[]) => any }>(page: T): T;
  /** Distinct ids looked up so far, sorted. */
  ids(): string[];
  /** Append the recorded ids to a shared artifact (safe across parallel workers). */
  appendTo(file: string): void;
}

export function createTestIdRecorder(): TestIdRecorder {
  const seen = new Set<string>();
  return {
    wrapPage(page) {
      const original = page.getByTestId.bind(page);
      page.getByTestId = ((id: string, ...rest: any[]) => {
        seen.add(id);
        return original(id, ...rest);
      }) as typeof page.getByTestId;
      return page;
    },
    ids() {
      return [...seen].sort();
    },
    appendTo(file) {
      const ids = [...seen];
      if (ids.length) appendFileSync(file, ids.join('\n') + '\n');
    },
  };
}

/** Read an exercised-ids artifact: one id per line, merged and deduped. */
export function readRuntimeRecord(file: string): string[] {
  if (!existsSync(file)) return [];
  return [...new Set(readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))].sort();
}
