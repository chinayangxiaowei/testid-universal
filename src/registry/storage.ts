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

export interface RegistryEntry {
  component: string;
  tag: string;
  element_type: string;
  fingerprint: string;
  semantic: Record<string, string | null>;
  source: 'generated' | 'manual';
  first_seen_version: number;
  last_seen_version: number;
  last_generated_at: string;
  generation_history: number[];
}

export interface RegistrySnapshot {
  version: number;
  generated_at: string;
  entries: Record<string, RegistryEntry>;
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
    const json = JSON.stringify(snapshot, null, 2);
    writeFileSync(this.versionFile(snapshot.version), json);
    writeFileSync(this.latestFile(), json);
  }
}
