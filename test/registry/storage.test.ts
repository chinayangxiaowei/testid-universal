import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalStringify, JsonFileStorage } from '../../src/registry/storage';
import { snapshot, entry } from '../helpers';

describe('canonicalStringify', () => {
  it('serializes identical content to identical bytes regardless of key insertion order', () => {
    const a = canonicalStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('preserves array order (generation_history order is meaningful)', () => {
    expect(canonicalStringify([3, 1, 2])).toBe(JSON.stringify([3, 1, 2], null, 2));
  });
});

describe('JsonFileStorage canonical writes', () => {
  it('writes byte-identical files for snapshots with reordered entry keys', async () => {
    const e1 = entry({ fingerprint: 'F', identity: 'x::a::one' });
    const e2 = entry({ fingerprint: 'G', identity: 'x::a::two' });

    const dirA = mkdtempSync(join(tmpdir(), 'tu-canon-'));
    await new JsonFileStorage(dirA).save(snapshot(1, { one: e1, two: e2 }));

    const dirB = mkdtempSync(join(tmpdir(), 'tu-canon-'));
    await new JsonFileStorage(dirB).save(snapshot(1, { two: e2, one: e1 })); // reordered

    expect(readFileSync(join(dirA, 'v1.json'), 'utf8')).toBe(readFileSync(join(dirB, 'v1.json'), 'utf8'));
  });
});
