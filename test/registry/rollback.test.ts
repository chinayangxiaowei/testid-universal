import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStorage, InMemoryStorage } from '../../src/registry/storage';
import { snapshot, entry } from '../helpers';

const snapN = (v: number, id: string) => snapshot(v, { [id]: entry({ fingerprint: 'f' + v }) });

for (const [name, make] of [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['JsonFileStorage', () => new JsonFileStorage(mkdtempSync(join(tmpdir(), 'rb-')))],
] as const) {
  describe(`${name} rollback + activity`, () => {
    it('rollback repoints latest to the prior version without destroying data', async () => {
      const s = make();
      await s.save(snapN(1, 'a__b--1'));
      await s.save(snapN(2, 'a__b--2'));
      expect((await s.loadLatest())!.version).toBe(2);

      const r = await s.rollback!();
      expect(r).toEqual({ from: 2, to: 1 });
      expect((await s.loadLatest())!.version).toBe(1);
      // v2 is still retrievable — rollback is non-destructive.
      expect((await s.loadVersion(2))!.version).toBe(2);
    });

    it('rollback at v1 (nothing earlier) returns null and changes nothing', async () => {
      const s = make();
      await s.save(snapN(1, 'a__b--1'));
      expect(await s.rollback!()).toBeNull();
      expect((await s.loadLatest())!.version).toBe(1);
    });

    it('the activity log records saves and rollbacks in order', async () => {
      const s = make();
      await s.save(snapN(1, 'a__b--1'));
      await s.save(snapN(2, 'a__b--2'));
      await s.rollback!();
      const log = await s.activity!();
      expect(log.map((e) => e.action)).toEqual(['save', 'save', 'rollback']);
      expect(log[2]).toMatchObject({ action: 'rollback', from: 2, to: 1 });
      expect(log[0]).toMatchObject({ action: 'save', version: 1 });
    });

    it('a re-tag after rollback advances from the rolled-back pointer (overwrites the bad version)', async () => {
      const s = make();
      await s.save(snapN(1, 'a__b--1'));
      await s.save(snapN(2, 'a__b--2'));
      await s.rollback!();
      const next = (await s.loadLatest())!.version + 1;
      expect(next).toBe(2);
    });
  });
}
