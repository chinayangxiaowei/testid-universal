import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageFromEnv } from '../../src/server/http';
import { JsonFileStorage } from '../../src/registry/storage';
import { PostgresStorage } from '../../src/registry/postgres';

// Downstream: `serve` silently defaulted to JsonFileStorage, which is only safe for
// processes on ONE host. Startup must say so, and DATABASE_URL must switch to Postgres.
describe('storageFromEnv (serve backend storage selection)', () => {
  it('without DATABASE_URL: JsonFileStorage plus an explicit single-host warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'testid-env-'));
    const { storage, warnings } = storageFromEnv({ REGISTRY_DIR: dir });
    expect(storage).toBeInstanceOf(JsonFileStorage);
    expect(warnings.join('\n')).toMatch(/JsonFileStorage/);
    expect(warnings.join('\n')).toMatch(/single host/i);
    expect(warnings.join('\n')).toMatch(/DATABASE_URL/);
  });

  it('with DATABASE_URL: PostgresStorage over a pool built from the url, no warning', () => {
    const seen: string[] = [];
    const fakePool = { query: async () => ({ rows: [] }), connect: async () => { throw new Error('unused'); } };
    const { storage, warnings } = storageFromEnv(
      { DATABASE_URL: 'postgres://u@h/db' },
      { makePool: (url) => { seen.push(url); return fakePool; } },
    );
    expect(storage).toBeInstanceOf(PostgresStorage);
    expect(seen).toEqual(['postgres://u@h/db']);
    expect(warnings).toEqual([]);
  });
});
