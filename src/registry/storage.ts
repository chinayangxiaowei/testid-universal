/**
 * Registry storage — the persistence seam, framework- and transport-agnostic.
 *
 * A RegistrySnapshot is one immutable, versioned view of every known testid plus
 * its provenance (first/last-seen versions, generated-vs-manual, regeneration
 * history). RegistryStorage is the small interface the rest of the system depends
 * on; swapping InMemory ↔ JsonFile ↔ (future) Postgres changes nothing upstream.
 *
 * NOTE (known limitation): JsonFileStorage is last-write-wins with no locking, so
 * concurrent multi-process writes can corrupt the registry. A transactional
 * PostgresStorage is the intended production implementation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { NormalizedSignals } from '../core/types';

export interface RegistryEntry {
  component: string;
  tag: string;
  element_type: string;
  identity: string;
  fingerprint: string;
  disambiguator: string;
  symbol_defs: Record<string, string>;
  signals: NormalizedSignals;
  /** Source file this element lives in (scopes partial tag runs). Absent on legacy entries. */
  file?: string;
  source: 'generated' | 'manual' | 'sticky';
  first_seen_version: number;
  last_seen_version: number;
  last_generated_at: string;
  generation_history: number[];
}

export interface RegistrySnapshot {
  version: number;
  generated_at: string;
  /** Ids present in this version. The active set diff and locators read from. */
  entries: Record<string, RegistryEntry>;
  /**
   * Provenance of ids that existed before but are NOT present in this version
   * (tombstones). Kept so that first_seen, manual source, and regeneration
   * history survive an id disappearing and later coming back. A retired entry's
   * last_seen_version marks the version it was last present in.
   */
  retired?: Record<string, RegistryEntry>;
}

/** One line in the registry's activity log. */
export interface ActivityEntry {
  action: 'save' | 'rollback';
  at: string;
  version?: number;      // save: the version written
  from?: number;         // rollback: the version rolled back from
  to?: number;           // rollback: the version rolled back to
}

export interface RegistryStorage {
  loadLatest(): Promise<RegistrySnapshot | null>;
  loadVersion(version: number): Promise<RegistrySnapshot | null>;
  save(snapshot: RegistrySnapshot): Promise<void>;
  /**
   * Repoint "latest" to the immediately-prior version (non-destructive — the
   * rolled-back version's file/record is kept, so a re-tag overwrites it).
   * Returns {from,to} or null when there is no earlier version.
   */
  rollback(): Promise<{ from: number; to: number } | null>;
  /** The append-only activity log (saves + rollbacks), oldest first. */
  activity(): Promise<ActivityEntry[]>;
}

/** Ephemeral, zero-setup storage — used by tests and the embedded demo. */
export class InMemoryStorage implements RegistryStorage {
  private versions = new Map<number, RegistrySnapshot>();
  private latestVersion = 0;

  async loadLatest(): Promise<RegistrySnapshot | null> {
    return this.latestVersion ? this.versions.get(this.latestVersion) ?? null : null;
  }
  async loadVersion(version: number): Promise<RegistrySnapshot | null> {
    return this.versions.get(version) ?? null;
  }
  private log: ActivityEntry[] = [];
  async save(snapshot: RegistrySnapshot): Promise<void> {
    this.versions.set(snapshot.version, snapshot);
    if (snapshot.version > this.latestVersion) this.latestVersion = snapshot.version;
    this.log.push({ action: 'save', version: snapshot.version, at: new Date().toISOString() });
  }
  async rollback(): Promise<{ from: number; to: number } | null> {
    if (this.latestVersion <= 1) return null;
    const from = this.latestVersion;
    const to = from - 1;
    this.latestVersion = to;
    this.log.push({ action: 'rollback', from, to, at: new Date().toISOString() });
    return { from, to };
  }
  async activity(): Promise<ActivityEntry[]> {
    return [...this.log];
  }
}

/**
 * File-backed storage: one `v<N>.json` per version plus a `latest.json` pointer.
 * This is the embedded CLI default — the registry lives in the repo as plain JSON.
 */
export class JsonFileStorage implements RegistryStorage {
  constructor(private dir: string) {}

  private versionFile(version: number): string {
    return join(this.dir, `v${version}.json`);
  }
  private latestFile(): string {
    return join(this.dir, 'latest.json');
  }
  private read(file: string): RegistrySnapshot | null {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as RegistrySnapshot;
  }

  async loadLatest(): Promise<RegistrySnapshot | null> {
    const pointed = this.read(this.latestFile());
    if (pointed) return pointed;
    // Fallback: derive the highest version from any v*.json on disk.
    if (!existsSync(this.dir)) return null;
    const versions = readdirSync(this.dir)
      .map((f) => /^v(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => m != null)
      .map((m) => Number(m[1]));
    if (versions.length === 0) return null;
    return this.read(this.versionFile(Math.max(...versions)));
  }
  async loadVersion(version: number): Promise<RegistrySnapshot | null> {
    return this.read(this.versionFile(version));
  }
  async save(snapshot: RegistrySnapshot): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const json = canonicalStringify(snapshot);
    writeFileSync(this.versionFile(snapshot.version), json);
    writeFileSync(this.latestFile(), json);
    this.appendActivity({ action: 'save', version: snapshot.version, at: new Date().toISOString() });
  }

  private activityFile(): string {
    return join(this.dir, 'activity.log');
  }
  private appendActivity(e: ActivityEntry): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.activityFile(), JSON.stringify(e) + '\n');
  }

  async rollback(): Promise<{ from: number; to: number } | null> {
    const current = await this.loadLatest();
    if (!current || current.version <= 1) return null;
    const from = current.version;
    // The immediately-prior version on disk (skip gaps from earlier rollbacks).
    let to = from - 1;
    while (to >= 1 && !existsSync(this.versionFile(to))) to--;
    if (to < 1) return null;
    const prior = this.read(this.versionFile(to))!;
    writeFileSync(this.latestFile(), canonicalStringify(prior));
    this.appendActivity({ action: 'rollback', from, to, at: new Date().toISOString() });
    return { from, to };
  }

  async activity(): Promise<ActivityEntry[]> {
    const file = this.activityFile();
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ActivityEntry);
  }
}

/**
 * JSON.stringify with object keys sorted at every level, so identical content
 * always serializes to identical bytes — registry files in version control diff
 * cleanly with no key-order churn. Array order is preserved (it is meaningful,
 * e.g. generation_history).
 */
export function canonicalStringify(value: unknown, space = 2): string {
  return JSON.stringify(sortKeysDeep(value), null, space);
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
