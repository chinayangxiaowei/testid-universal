import { describe, it, expect } from 'vitest';
import { PostgresStorage } from '../../src/registry/postgres';
import { RegistryConflictError } from '../../src/registry/storage';
import { snapshot, entry } from '../helpers';

/**
 * Functional fake of a pg Pool: models the three tables in memory by recognizing
 * the storage's own statements. Verifies real behavior, not SQL strings.
 */
function fakePool() {
  const snapshots = new Map<number, any>();
  let latest: number | null = null;
  const activity: any[] = [];
  let activitySeq = 0;
  const ddl: string[] = [];

  async function query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
    if (/CREATE TABLE/i.test(s)) { ddl.push(s); return { rows: [] }; }
    if (/INSERT INTO testid_snapshots/i.test(s)) { snapshots.set(params[0], params[1]); return { rows: [] }; }
    if (/INSERT INTO testid_meta/i.test(s)) { latest = latest == null ? params[0] : Math.max(latest, params[0]); return { rows: [] }; }
    if (/UPDATE testid_meta/i.test(s)) { latest = params[0]; return { rows: [] }; }
    if (/INSERT INTO testid_activity/i.test(s)) {
      // The save and rollback inserts use different column lists; map by columns.
      const row: any = { id: ++activitySeq, action: params[0], version: null, from_version: null, to_version: null, at: '2026-01-01T00:00:00.000Z' };
      if (/\(action, version, at\)/i.test(s)) row.version = params[1];
      else if (/\(action, from_version, to_version, at\)/i.test(s)) { row.from_version = params[1]; row.to_version = params[2]; }
      activity.push(row);
      return { rows: [] };
    }
    // Order matters: the loadLatest statement embeds "SELECT latest_version FROM
    // testid_meta" as a subquery, so match the snapshot-by-latest form first.
    if (/FROM testid_snapshots WHERE version = \(SELECT/i.test(s)) return { rows: latest != null && snapshots.has(latest) ? [{ data: snapshots.get(latest) }] : [] };
    if (/SELECT latest_version FROM testid_meta/i.test(s)) return { rows: latest == null ? [] : [{ latest_version: latest }] };
    if (/SELECT max\(version\)/i.test(s)) {
      const below = [...snapshots.keys()].filter((v) => v < params[0]);
      return { rows: [{ max: below.length ? Math.max(...below) : null }] };
    }
    if (/FROM testid_snapshots WHERE version = \$1/i.test(s)) return { rows: snapshots.has(params[0]) ? [{ data: snapshots.get(params[0]) }] : [] };
    if (/FROM testid_activity/i.test(s)) return { rows: [...activity].sort((a, b) => a.id - b.id) };
    throw new Error('unrecognized SQL: ' + s);
  }
  return { query, _ddl: ddl };
}

const snapN = (v: number) => snapshot(v, { [`a__b--${v}`]: entry({ fingerprint: 'f' + v }) });

describe('PostgresStorage', () => {
  it('init creates the tables idempotently', async () => {
    const pool = fakePool();
    const s = new PostgresStorage(pool as any);
    await s.init();
    expect(pool._ddl.length).toBeGreaterThanOrEqual(3);
  });

  it('save then loadLatest round-trips the snapshot', async () => {
    const s = new PostgresStorage(fakePool() as any);
    await s.save(snapN(1));
    await s.save(snapN(2));
    const latest = await s.loadLatest();
    expect(latest!.version).toBe(2);
    expect(await s.loadLatest()).toEqual(snapN(2));
  });

  it('loadVersion fetches a specific version; missing -> null', async () => {
    const s = new PostgresStorage(fakePool() as any);
    await s.save(snapN(1));
    expect((await s.loadVersion(1))!.version).toBe(1);
    expect(await s.loadVersion(9)).toBeNull();
  });

  it('rollback repoints latest to the prior version, non-destructively', async () => {
    const s = new PostgresStorage(fakePool() as any);
    await s.save(snapN(1));
    await s.save(snapN(2));
    expect(await s.rollback()).toEqual({ from: 2, to: 1 });
    expect((await s.loadLatest())!.version).toBe(1);
    expect((await s.loadVersion(2))!.version).toBe(2); // still there
  });

  it('rollback at v1 returns null', async () => {
    const s = new PostgresStorage(fakePool() as any);
    await s.save(snapN(1));
    expect(await s.rollback()).toBeNull();
  });

  it('activity records saves and rollbacks in order', async () => {
    const s = new PostgresStorage(fakePool() as any);
    await s.save(snapN(1));
    await s.save(snapN(2));
    await s.rollback();
    const log = await s.activity();
    expect(log.map((e) => e.action)).toEqual(['save', 'save', 'rollback']);
    expect(log[2]).toMatchObject({ action: 'rollback', from: 2, to: 1 });
  });

  it('loadLatest on an empty registry is null', async () => {
    const s = new PostgresStorage(fakePool() as any);
    expect(await s.loadLatest()).toBeNull();
  });

  // Lost-update protection (downstream report): ON CONFLICT DO UPDATE used to let a
  // stale writer silently overwrite a version another writer had just saved.
  it('rejects a stale writer (compare-and-swap on the base version) instead of overwriting', async () => {
    const s = new PostgresStorage(fakePool() as any);
    await s.save(snapN(1));
    await s.save(snapN(2), { expectedLatest: 1 });
    await expect(s.save(snapshot(2, { other: entry({ fingerprint: 'zz' }) }), { expectedLatest: 1 }))
      .rejects.toBeInstanceOf(RegistryConflictError);
    expect(Object.keys((await s.loadVersion(2))!.entries)).toEqual(['a__b--2']);
  });

  it('without an explicit base, refuses to write a version <= latest', async () => {
    const s = new PostgresStorage(fakePool() as any);
    await s.save(snapN(1));
    await s.save(snapN(2));
    await expect(s.save(snapN(2))).rejects.toBeInstanceOf(RegistryConflictError);
  });

  it('a rolled-back version may be rewritten on top of the new latest', async () => {
    const s = new PostgresStorage(fakePool() as any);
    await s.save(snapN(1));
    await s.save(snapN(2));
    await s.rollback();
    await s.save(snapshot(2, { good: entry({ fingerprint: 'g' }) }), { expectedLatest: 1 });
    expect(Object.keys((await s.loadLatest())!.entries)).toEqual(['good']);
  });
});
