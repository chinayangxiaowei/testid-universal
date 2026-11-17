import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStorage, InMemoryStorage, RegistryStorage, RegistryConflictError } from '../../src/registry/storage';
import { TestIdService } from '../../src/server/service';
import { ElementNode } from '../../src/core/types';
import { snapshot, entry } from '../helpers';

// Lost-update protection (downstream report): two writers that both read latest=N
// and both write N+1 must NEVER silently overwrite each other. The storage rejects
// the stale writer with RegistryConflictError (compare-and-swap on the base version);
// TestIdService.tag rebases and retries, so concurrent tags serialize into N+1, N+2.

const tmp = () => mkdtempSync(join(tmpdir(), 'testid-race-'));
const snap = (v: number, ids: string[]) =>
  snapshot(v, Object.fromEntries(ids.map((id) => [id, entry({ fingerprint: 'f-' + id, identity: 'i::' + id })])));

const backends: [string, () => [RegistryStorage, RegistryStorage]][] = [
  ['JsonFileStorage (two instances, one dir)', () => { const d = tmp(); return [new JsonFileStorage(d), new JsonFileStorage(d)]; }],
  ['InMemoryStorage (one instance, two writers)', () => { const s = new InMemoryStorage(); return [s, s]; }],
];

describe.each(backends)('%s — compare-and-swap save', (_name, make) => {
  it('downstream repro: the stale writer is rejected, the first write survives intact', async () => {
    const [a, b] = make();
    await a.save(snap(1, ['base']));
    const prevA = (await a.loadLatest())!;
    const prevB = (await b.loadLatest())!;
    await a.save(snap(prevA.version + 1, ['base', 'a']), { expectedLatest: prevA.version });
    await expect(b.save(snap(prevB.version + 1, ['base', 'b']), { expectedLatest: prevB.version }))
      .rejects.toBeInstanceOf(RegistryConflictError);
    const v2 = (await a.loadVersion(2))!;
    expect(Object.keys(v2.entries).sort()).toEqual(['a', 'base']);
    expect((await b.loadLatest())!.version).toBe(2);
  });

  it('without an explicit base, writing a version <= latest is still rejected (monotonic)', async () => {
    const [a, b] = make();
    await a.save(snap(1, ['x']));
    await a.save(snap(2, ['x', 'a']));
    await expect(b.save(snap(2, ['x', 'b']))).rejects.toBeInstanceOf(RegistryConflictError);
  });

  it('a tag racing a rollback is rejected instead of silently undoing it', async () => {
    const [a, b] = make();
    await a.save(snap(1, ['x']));
    await a.save(snap(2, ['x', 'bad']));
    const base = (await a.loadLatest())!;           // tagger read v2 ...
    await b.rollback();                              // ... rollback moves latest to v1 ...
    await expect(a.save(snap(3, ['x', 'bad', 'more']), { expectedLatest: base.version }))
      .rejects.toBeInstanceOf(RegistryConflictError); // ... the v2-based write must not land
    expect((await a.loadLatest())!.version).toBe(1);
  });

  it('after a rollback, re-tagging on the new latest overwrites the rolled-back version (documented)', async () => {
    const [a] = make();
    await a.save(snap(1, ['x']));
    await a.save(snap(2, ['x', 'bad']));
    await a.rollback();
    await a.save(snap(2, ['x', 'good']), { expectedLatest: 1 });
    expect(Object.keys((await a.loadLatest())!.entries).sort()).toEqual(['good', 'x']);
  });
});

describe('TestIdService.tag — concurrent tags rebase instead of losing work', () => {
  const node = (file: string, component: string, name: string): ElementNode => ({
    component, tag: 'button', signals: { name }, existingId: null, loc: { file, start: 0, end: 10 },
  });

  it('two services on one registry dir, tagging different files at once: both land (v2, v3)', async () => {
    const dir = tmp();
    const s0 = new TestIdService(new JsonFileStorage(dir));
    await s0.tag({ nodes: [node('base.html', 'base', 'x')] });
    const sa = new TestIdService(new JsonFileStorage(dir));
    const sb = new TestIdService(new JsonFileStorage(dir));
    const [ra, rb] = await Promise.all([
      sa.tag({ nodes: [node('a.html', 'a', 'savea')] }),
      sb.tag({ nodes: [node('b.html', 'b', 'saveb')] }),
    ]);
    expect([ra.version, rb.version].sort()).toEqual([2, 3]);
    const latest = (await s0.latest())!;
    expect(latest.version).toBe(3);
    expect(Object.keys(latest.entries).sort()).toEqual(['a__button--savea', 'b__button--saveb', 'base__button--x']);
    // The first writer's version is intact, not overwritten.
    const v2 = JSON.parse(readFileSync(join(dir, 'v2.json'), 'utf8'));
    expect(Object.keys(v2.entries).length).toBe(2);
  });
});

describe('JsonFileStorage — atomic writes & inter-process lock', () => {
  it('leaves no temp or lock files behind and every file parses', async () => {
    const dir = tmp();
    const s = new JsonFileStorage(dir);
    await s.save(snap(1, ['x']));
    await s.save(snap(2, ['x', 'y']), { expectedLatest: 1 });
    await s.rollback();
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['activity.log', 'latest.json', 'v1.json', 'v2.json']);
    for (const f of files.filter((x) => x.endsWith('.json'))) expect(() => JSON.parse(readFileSync(join(dir, f), 'utf8'))).not.toThrow();
  });

  it('a held lock blocks the writer until timeout, with an explicit error (no silent write)', async () => {
    const dir = tmp();
    const s = new JsonFileStorage(dir, { lockTimeoutMs: 150, staleLockMs: 60_000 });
    await s.save(snap(1, ['x']));
    writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
    await expect(s.save(snap(2, ['x', 'y']), { expectedLatest: 1 })).rejects.toThrow(/lock/i);
    expect(existsSync(join(dir, 'v2.json'))).toBe(false);
  });

  it('a stale lock (crashed writer) is reclaimed', async () => {
    const dir = tmp();
    const s = new JsonFileStorage(dir, { lockTimeoutMs: 2000, staleLockMs: 1000 });
    await s.save(snap(1, ['x']));
    const lock = join(dir, '.lock');
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: 0 }));
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    await s.save(snap(2, ['x', 'y']), { expectedLatest: 1 });
    expect((await s.loadLatest())!.version).toBe(2);
    expect(existsSync(lock)).toBe(false);
  });
});
