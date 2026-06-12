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
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
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

export interface RegistryStorage {
  loadLatest(): Promise<RegistrySnapshot | null>;
  loadVersion(version: number): Promise<RegistrySnapshot | null>;
  save(snapshot: RegistrySnapshot): Promise<void>;
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
  async save(snapshot: RegistrySnapshot): Promise<void> {
    this.versions.set(snapshot.version, snapshot);
    if (snapshot.version > this.latestVersion) this.latestVersion = snapshot.version;
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
