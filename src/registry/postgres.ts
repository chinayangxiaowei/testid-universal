/**
 * PostgresStorage — the transactional, multi-writer-safe RegistryStorage for a
 * shared service (the production answer to JsonFileStorage's last-write-wins).
 *
 * It NEVER imports `pg`: you pass in any `pg.Pool`-compatible object (`{ query }`,
 * optionally `{ connect }` for real transactions), so the core package stays
 * dependency-free and this works with `pg`, `postgres.js` shims, or a test double.
 *
 *   import { Pool } from 'pg';
 *   const storage = new PostgresStorage(new Pool({ connectionString }));
 *   await storage.init();           // CREATE TABLE IF NOT EXISTS (idempotent)
 *   const transport = new LocalTransport(storage);
 *
 * Schema: `testid_snapshots(version, data jsonb)` holds every immutable version;
 * `testid_meta(latest_version)` is the single-row pointer; `testid_activity` is
 * the append-only log. Rollback moves the pointer (non-destructive), mirroring
 * JsonFileStorage exactly so callers cannot tell the backends apart.
 */
import { RegistrySnapshot, RegistryStorage, ActivityEntry } from './storage';

/** The pg surface we use — a Pool or a single Client both satisfy it. */
export interface PgQueryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
  /** Optional: a Pool exposing connect() gets real BEGIN/COMMIT on one client. */
  connect?: () => Promise<PgClient>;
}
export interface PgClient {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
  release(): void;
}

export class PostgresStorage implements RegistryStorage {
  constructor(private pool: PgQueryable) {}

  /** Create the schema if absent. Safe to call on every boot. */
  async init(): Promise<void> {
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS testid_snapshots (version INT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS testid_meta (id INT PRIMARY KEY DEFAULT 1, latest_version INT, CONSTRAINT testid_meta_singleton CHECK (id = 1))',
    );
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS testid_activity (id BIGSERIAL PRIMARY KEY, action TEXT NOT NULL, version INT, from_version INT, to_version INT, at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
  }

  async loadLatest(): Promise<RegistrySnapshot | null> {
    const r = await this.pool.query(
      'SELECT data FROM testid_snapshots WHERE version = (SELECT latest_version FROM testid_meta WHERE id = 1)',
    );
    return r.rows.length ? asSnapshot(r.rows[0].data) : null;
  }

  async loadVersion(version: number): Promise<RegistrySnapshot | null> {
    const r = await this.pool.query('SELECT data FROM testid_snapshots WHERE version = $1', [version]);
    return r.rows.length ? asSnapshot(r.rows[0].data) : null;
  }

  async save(snapshot: RegistrySnapshot): Promise<void> {
    const now = new Date().toISOString();
    await this.tx(async (q) => {
      await q('INSERT INTO testid_snapshots (version, data) VALUES ($1, $2) ON CONFLICT (version) DO UPDATE SET data = EXCLUDED.data', [snapshot.version, snapshot as unknown]);
      await q('INSERT INTO testid_meta (id, latest_version) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET latest_version = GREATEST(testid_meta.latest_version, EXCLUDED.latest_version)', [snapshot.version]);
      await q('INSERT INTO testid_activity (action, version, at) VALUES ($1, $2, $3)', ['save', snapshot.version, now]);
    });
  }

  async rollback(): Promise<{ from: number; to: number } | null> {
    const now = new Date().toISOString();
    return this.tx(async (q) => {
      const cur = await q('SELECT latest_version FROM testid_meta WHERE id = 1', []);
      const from = cur.rows.length ? cur.rows[0].latest_version : null;
      if (from == null || from <= 1) return null;
      const prior = await q('SELECT max(version) AS max FROM testid_snapshots WHERE version < $1', [from]);
      const to = prior.rows[0]?.max ?? null;
      if (to == null) return null;
      await q('UPDATE testid_meta SET latest_version = $1 WHERE id = 1', [to]);
      await q('INSERT INTO testid_activity (action, from_version, to_version, at) VALUES ($1, $2, $3, $4)', ['rollback', from, to, now]);
      return { from, to };
    });
  }

  async activity(): Promise<ActivityEntry[]> {
    const r = await this.pool.query('SELECT action, version, from_version, to_version, at FROM testid_activity ORDER BY id', []);
    return r.rows.map((row) => {
      const e: ActivityEntry = { action: row.action, at: typeof row.at === 'string' ? row.at : new Date(row.at).toISOString() };
      if (row.version != null) e.version = row.version;
      if (row.from_version != null) e.from = row.from_version;
      if (row.to_version != null) e.to = row.to_version;
      return e;
    });
  }

  /**
   * Run a unit of work transactionally. With a Pool exposing connect(), the
   * statements run BEGIN/COMMIT on ONE pooled client (real isolation); without
   * it, they run sequentially on the shared queryable (best-effort — documented).
   */
  private async tx<T>(work: (q: (sql: string, params?: any[]) => Promise<{ rows: any[] }>) => Promise<T>): Promise<T> {
    if (this.pool.connect) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work((sql, params) => client.query(sql, params));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }
    return work((sql, params) => this.pool.query(sql, params));
  }
}

/** Snapshots are stored as JSONB; pg returns them already parsed, but tolerate text. */
function asSnapshot(data: unknown): RegistrySnapshot {
  return (typeof data === 'string' ? JSON.parse(data) : data) as RegistrySnapshot;
}
