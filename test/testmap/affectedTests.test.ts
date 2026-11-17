import { describe, it, expect } from 'vitest';
import { affectedTests, affectedTestsToMarkdown } from '../../src/testmap';
import { DiffResult } from '../../src/registry/diff';

const diff: DiffResult = {
  from_version: 1, to_version: 2,
  summary: { unchanged: 0, added: 1, removed: 1, modified: 1, regenerated: 0 },
  added: [{ id: 'a__new', identity: 'a::x::new', component: 'a' }],
  removed: [{ id: 'a__gone', identity: 'a::x::gone', component: 'a' }],
  modified: [{ id: 'a__changed', identity: 'a::x::changed', component: 'a', changes: [{ field: 'text', old: 'A', new: 'B' }] }],
  regenerated: [],
};

const map = { a__changed: ['spec/x.spec.ts'], a__gone: ['spec/y.spec.ts'] };

describe('affectedTests', () => {
  it('routes a regenerated id to re-test', () => {
    const d = {
      from_version: 1, to_version: 2,
      summary: { unchanged: 0, added: 0, removed: 0, modified: 0, regenerated: 1 },
      added: [], removed: [], modified: [],
      regenerated: [{ id: 'a__reborn', identity: 'a::x::reborn', component: 'a' }],
    } as const;
    const aff = affectedTests(d as any, { a__reborn: ['spec/r.spec.ts'] });
    expect(aff.find((a) => a.id === 'a__reborn')).toMatchObject({ action: 're-test', tests: ['spec/r.spec.ts'] });
  });

  it('routes each diff change to its action and referencing tests', () => {
    const aff = affectedTests(diff, map);
    expect(aff.find((a) => a.id === 'a__changed')).toMatchObject({ action: 're-test', tests: ['spec/x.spec.ts'] });
    expect(aff.find((a) => a.id === 'a__gone')).toMatchObject({ action: 'retire', tests: ['spec/y.spec.ts'] });
    expect(aff.find((a) => a.id === 'a__new')).toMatchObject({ action: 'write-new', tests: [] });
  });
});

describe('affectedTestsToMarkdown', () => {
  it('renders the actions and cites the tests', () => {
    const md = affectedTestsToMarkdown(affectedTests(diff, map));
    expect(md).toContain('re-test');
    expect(md).toContain('a__changed');
    expect(md).toContain('spec/x.spec.ts');
  });
});

// Downstream: affected must not read as "safe" for tests whose elements depend on code
// beyond tracking depth — it lists them with a full-suite fallback hint.
import { depthLimitedTests, depthLimitedToMarkdown } from '../../src/testmap';
import { snapshot as snap2, entry as entry2 } from '../helpers';

describe('depthLimitedTests', () => {
  const s = snap2(3, {
    'p__button--submit': entry2({ fingerprint: 'F', dep_limited: ['submit>createOrder>validate'] }),
    'p__button--cancel': entry2({ fingerprint: 'G' }),
    'p__button--orphan': entry2({ fingerprint: 'H', dep_limited: ['x>y>z'] }),
  });
  const map = { 'p__button--submit': ['order.spec.ts'], 'p__button--cancel': ['order.spec.ts'] };

  it('lists only tested ids whose dependency chain goes beyond tracking depth', () => {
    expect(depthLimitedTests(s, map)).toEqual([
      { id: 'p__button--submit', limits: ['submit>createOrder>validate'], tests: ['order.spec.ts'] },
    ]);
  });

  it('markdown names the fallback and stays empty when nothing is limited', () => {
    const md = depthLimitedToMarkdown(depthLimitedTests(s, map));
    expect(md).toMatch(/beyond tracking depth/i);
    expect(md).toMatch(/full suite/i);
    expect(md).toContain('submit>createOrder>validate');
    expect(depthLimitedToMarkdown([])).toBe('');
  });
});

// `affected --out-list FILE --include-limited`: the runner list also carries the
// beyond-depth fallback tests, so the CLI route matches the reference CI script.
import { retestFiles } from '../../src/testmap';

describe('retestFiles (runner list for --out-list)', () => {
  const affected = [
    { id: 'a', action: 're-test' as const, tests: [{ file: 'b.spec.ts', test: 'x' }, { file: 'a.spec.ts', test: 'y' }] },
    { id: 'n', action: 'write-new' as const, tests: [{ file: 'new.spec.ts', test: '' }] },
  ];
  const limited = [{ id: 'l', limits: ['s>f>g'], tests: ['deep.spec.ts', 'a.spec.ts'] }];

  it('only re-test files by default, sorted and unique', () => {
    expect(retestFiles(affected)).toEqual(['a.spec.ts', 'b.spec.ts']);
  });

  it('adds the beyond-depth fallback tests when given', () => {
    expect(retestFiles(affected, limited)).toEqual(['a.spec.ts', 'b.spec.ts', 'deep.spec.ts']);
  });

  it('accepts the file-level affected shape too', () => {
    expect(retestFiles([{ id: 'a', action: 're-test', tests: ['z.spec.ts'] }], limited)).toEqual(['a.spec.ts', 'deep.spec.ts', 'z.spec.ts']);
  });
});
