/**
 * Registry storage — the persistence seam, framework- and transport-agnostic.
 *
 * A RegistrySnapshot is one immutable, versioned view of every known testid plus
 * its provenance (first/last-seen versions, generated-vs-manual, regeneration
 * history). RegistryStorage is the small interface the rest of the system depends
 * on; swapping InMemory ↔ JsonFile ↔ (future) Postgres changes nothing upstream.
 *
 * Every backend enforces the same lost-update rule: `save` is a compare-and-swap on
 * the base version (see SaveOptions) and rejects a stale writer with
 * RegistryConflictError — never a silent overwrite. TestIdService.tag rebases and
 * retries on conflict, so concurrent tags serialize into consecutive versions.
 * JsonFileStorage guards its critical section with a lock file (single host / local
 * filesystem) and writes atomically (temp + rename); PostgresStorage uses a row lock.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync,
  openSync, closeSync, writeSync, renameSync, unlinkSync, statSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * A save lost the race: the registry moved on (another writer saved, or a rollback
 * repointed latest) since the snapshot's base was read. Re-read latest, rebuild the
 * snapshot on top of it, and save again.
 */
export class RegistryConflictError extends Error {
  readonly code = 'REGISTRY_CONFLICT';
  constructor(readonly attempted: number, readonly latest: number | null, readonly expected?: number | null) {
    super(
      expected !== undefined
        ? `registry conflict: snapshot v${attempted} was built on v${expected ?? 'none'}, but latest is now v${latest ?? 'none'} (concurrent write or rollback) -- re-read and retry`
        : `registry conflict: cannot write v${attempted}, latest is already v${latest} (concurrent write) -- re-read and retry`,
    );
    this.name = 'RegistryConflictError';
  }
}

export interface SaveOptions {
  /**
   * The latest version this snapshot was built on (null = empty registry). When given,
   * save succeeds only if latest still equals it. When omitted, save only refuses to
   * write a version <= the current latest. Either way a stale writer gets
   * RegistryConflictError instead of overwriting someone else's version.
   */
  expectedLatest?: number | null;
}

/** The shared CAS rule every backend applies inside its critical section. */
export function checkSave(attempted: number, latest: number | null, opts?: SaveOptions): void {
  if (opts && opts.expectedLatest !== undefined) {
    if ((latest ?? null) !== (opts.expectedLatest ?? null)) throw new RegistryConflictError(attempted, latest, opts.expectedLatest);
  } else if (latest != null && latest >= attempted) {
    throw new RegistryConflictError(attempted, latest);
  }
}
import { NormalizedSignals } from '../core/types';

export interface RegistryEntry {
  component: string;
  tag: string;
  element_type: string;
  identity: string;
  fingerprint: string;
  disambiguator: string;
  symbol_defs: Record<string, string>;
  /** Layer-2 dep hashes; absent on legacy entries and when tracking was off. */
  dep_defs?: Record<string, string>;
  /** Dependencies beyond tracking depth (layer 3 / dynamic); report only, never diffed. */
  dep_limited?: string[];
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
  /** Persist a new version. Rejects with RegistryConflictError on a lost update (see SaveOptions). */
  save(snapshot: RegistrySnapshot, opts?: SaveOptions): Promise<void>;
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
  async save(snapshot: RegistrySnapshot, opts?: SaveOptions): Promise<void> {
    checkSave(snapshot.version, this.latestVersion || null, opts);
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
export interface JsonFileStorageOptions {
  /** How long a writer waits for the registry lock before failing (default 10s). */
  lockTimeoutMs?: number;
  /** A lock file older than this is a crashed writer's and is reclaimed (default 30s). */
  staleLockMs?: number;
}

export class JsonFileStorage implements RegistryStorage {
  private lockTimeoutMs: number;
  private staleLockMs: number;
  constructor(private dir: string, opts: JsonFileStorageOptions = {}) {
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 10_000;
    this.staleLockMs = opts.staleLockMs ?? 30_000;
  }

  private lockFile(): string {
    return join(this.dir, '.lock');
  }

  /**
   * Inter-process mutex for the read-check-write critical section: exclusive create
   * of `<dir>/.lock` (O_EXCL is atomic on a local filesystem). Contenders back off and
   * retry until lockTimeoutMs; a lock older than staleLockMs (a crashed writer) is
   * reclaimed. Held only for the few milliseconds of the write itself.
   */
  private withLock<T>(fn: () => T): T {
    mkdirSync(this.dir, { recursive: true });
    const lock = this.lockFile();
    const deadline = Date.now() + this.lockTimeoutMs;
    let delay = 5;
    for (;;) {
      try {
        const fd = openSync(lock, 'wx');
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          closeSync(fd);
        }
        break;
      } catch (e: any) {
        if (e?.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > this.staleLockMs) {
            unlinkSync(lock); // crashed holder; whoever wins the next O_EXCL gets it
            continue;
          }
        } catch {
          continue; // lock vanished between EEXIST and stat: retry immediately
        }
        if (Date.now() >= deadline) {
          throw new Error(`registry lock timeout: ${lock} is held by another writer (remove it if no tag/rollback is running)`);
        }
        sleepSync(delay);
        delay = Math.min(delay * 2, 100);
      }
    }
    try {
      return fn();
    } finally {
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  }

  /** Atomic replace: write a sibling temp file, then rename over the target. */
  private writeAtomic(file: string, content: string): void {
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  }

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
  async save(snapshot: RegistrySnapshot, opts?: SaveOptions): Promise<void> {
    const json = canonicalStringify(snapshot);
    this.withLock(() => {
      // Re-read latest INSIDE the lock: this is the compare in compare-and-swap.
      checkSave(snapshot.version, this.latestVersionOnDisk(), opts);
      this.writeAtomic(this.versionFile(snapshot.version), json);
      this.writeAtomic(this.latestFile(), json);
      this.appendActivity({ action: 'save', version: snapshot.version, at: new Date().toISOString() });
    });
  }

  private latestVersionOnDisk(): number | null {
    const pointed = this.read(this.latestFile());
    if (pointed) return pointed.version;
    if (!existsSync(this.dir)) return null;
    const versions = readdirSync(this.dir)
      .map((f) => /^v(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => m != null)
      .map((m) => Number(m[1]));
    return versions.length ? Math.max(...versions) : null;
  }

  private activityFile(): string {
    return join(this.dir, 'activity.log');
  }
  private appendActivity(e: ActivityEntry): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.activityFile(), JSON.stringify(e) + '\n');
  }

  async rollback(): Promise<{ from: number; to: number } | null> {
    return this.withLock(() => {
      const from = this.latestVersionOnDisk();
      if (from == null || from <= 1) return null;
      // The immediately-prior version on disk (skip gaps from earlier rollbacks).
      let to = from - 1;
      while (to >= 1 && !existsSync(this.versionFile(to))) to--;
      if (to < 1) return null;
      const prior = this.read(this.versionFile(to))!;
      this.writeAtomic(this.latestFile(), canonicalStringify(prior));
      this.appendActivity({ action: 'rollback', from, to, at: new Date().toISOString() });
      return { from, to };
    });
  }

  async activity(): Promise<ActivityEntry[]> {
    const file = this.activityFile();
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ActivityEntry);
  }
}

/** Synchronous sleep (lock backoff) without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
