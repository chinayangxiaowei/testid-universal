import { describe, it, expect } from 'vitest';
import { diff, similarity } from '../../src/registry/diff';
import { snapshot, entry } from '../helpers';

describe('similarity', () => {
  it('is 1 for identical strings and 0 against empty', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('abc', '')).toBe(0);
  });

  it('is normalized edit distance', () => {
    // "aaaaaaaaaa" vs "aaaaabbbbb": 5 edits over length 10 -> 0.5
    expect(similarity('aaaaaaaaaa', 'aaaaabbbbb')).toBeCloseTo(0.5, 5);
  });
});

describe('diff', () => {
  it('counts an id present unchanged in both versions', () => {
    const v1 = snapshot(1, { a: entry({ fingerprint: 'F' }) });
    const v2 = snapshot(2, { a: entry({ fingerprint: 'F' }) });
    expect(diff(v1, v2).summary.unchanged).toBe(1);
  });

  it('detects a modification: same id, changed fingerprint', () => {
    const v1 = snapshot(1, { a: entry({ fingerprint: 'F1' }) });
    const v2 = snapshot(2, { a: entry({ fingerprint: 'F2' }) });
    const d = diff(v1, v2);
    expect(d.summary.modified).toBe(1);
    expect(d.modified[0]).toMatchObject({ id: 'a', old_fingerprint: 'F1', new_fingerprint: 'F2' });
  });

  it('detects a rename: id changes but fingerprint is (nearly) identical', () => {
    const v1 = snapshot(1, { 'old-id': entry({ fingerprint: 'SAME' }) });
    const v2 = snapshot(2, { 'new-id': entry({ fingerprint: 'SAME' }) });
    const d = diff(v1, v2);
    expect(d.summary).toMatchObject({ renamed: 1, added: 0, removed: 0 });
    expect(d.renamed[0]).toMatchObject({ old_id: 'old-id', new_id: 'new-id', confidence: 1 });
  });

  it('reports a pure add and a pure remove when nothing matches', () => {
    const v1 = snapshot(1, { gone: entry({ fingerprint: 'XXXXXXXXXX' }) });
    const v2 = snapshot(2, { fresh: entry({ fingerprint: 'YYYYYYYYYY' }) });
    const d = diff(v1, v2);
    expect(d.summary).toMatchObject({ added: 1, removed: 1, renamed: 0 });
    expect(d.added[0].id).toBe('fresh');
    expect(d.removed[0].id).toBe('gone');
  });

  it('classifies an unmatched add with multi-version history as "regenerated"', () => {
    const v1 = snapshot(1, { other: entry({ fingerprint: 'AAAAAAAAAA' }) });
    const v2 = snapshot(2, {
      other: entry({ fingerprint: 'AAAAAAAAAA' }),
      reborn: entry({ fingerprint: 'BBBBBBBBBB', generation_history: [1, 2] }),
    });
    const d = diff(v1, v2);
    expect(d.summary.regenerated).toBe(1);
    expect(d.summary.added).toBe(0);
    expect(d.regenerated[0].id).toBe('reborn');
  });

  it('threshold gates rename vs add+remove', () => {
    const v1 = snapshot(1, { a: entry({ fingerprint: 'aaaaaaaaaa' }) });
    const v2 = snapshot(2, { b: entry({ fingerprint: 'aaaaabbbbb' }) }); // similarity 0.5
    expect(diff(v1, v2, 0.4).summary.renamed).toBe(1); // below threshold -> matched
    const strict = diff(v1, v2, 0.6);
    expect(strict.summary.renamed).toBe(0); // above threshold -> not matched
    expect(strict.summary).toMatchObject({ added: 1, removed: 1 });
  });

  it('rename detection is greedy best-first and never reuses an added id', () => {
    const v1 = snapshot(1, {
      old1: entry({ fingerprint: 'SAME' }),
      old2: entry({ fingerprint: 'SAME' }),
    });
    const v2 = snapshot(2, { new1: entry({ fingerprint: 'SAME' }) });
    const d = diff(v1, v2);
    // Only one rename possible; the other old id becomes a removal.
    expect(d.summary.renamed).toBe(1);
    expect(d.summary.removed).toBe(1);
  });
});
