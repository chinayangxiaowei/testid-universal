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
