import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestIdRecorder, readRuntimeRecord } from '../../src/runtime';

describe('createTestIdRecorder', () => {
  it('records every id looked up through a wrapped page-like object', () => {
    const rec = createTestIdRecorder();
    const calls: string[] = [];
    const page = { getByTestId: (id: string) => { calls.push(id); return { id }; } };
    const wrapped = rec.wrapPage(page);
    wrapped.getByTestId('a__b--c');
    wrapped.getByTestId('a__b--c');
    wrapped.getByTestId('x__y--z');
    expect(calls).toEqual(['a__b--c', 'a__b--c', 'x__y--z']); // passthrough intact
    expect(rec.ids()).toEqual(['a__b--c', 'x__y--z']);        // deduped, sorted
  });

  it('appends to a line-based artifact that readRuntimeRecord merges and dedupes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tu-rt-')), 'exercised.txt');
    const r1 = createTestIdRecorder();
    r1.wrapPage({ getByTestId: (id: string) => id }).getByTestId('one');
    r1.appendTo(file);
    const r2 = createTestIdRecorder();
    const w2 = r2.wrapPage({ getByTestId: (id: string) => id });
    w2.getByTestId('two'); w2.getByTestId('one');
    r2.appendTo(file); // second worker appends
    expect(readRuntimeRecord(file)).toEqual(['one', 'two']);
    expect(readFileSync(file, 'utf8').trim().split('\n').length).toBe(3);
  });
});
