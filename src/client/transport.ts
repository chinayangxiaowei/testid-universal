/**
 * Transport abstraction — the key to "library by default, service when you want it".
 *
 * Everything that consumes the engine (the pipeline, the CLI) depends ONLY on this
 * interface. Two implementations satisfy it:
 *
 *   LocalTransport  — wraps TestIdService in the same process. No server, no network,
 *                     no setup. This is the default and what a build step / CLI uses.
 *   HttpTransport   — talks to a remote testid-universal backend over REST.
 *
 * Switching from embedded to centralized is a one-line change at construction time;
 * no calling code is touched.
 */
import { TagRequest, TagResponse, TestIdService } from '../server/service';
import { RegistrySnapshot, RegistryStorage, ActivityEntry } from '../registry/storage';
import { DiffResult } from '../registry/diff';
import { LocatorTarget } from '../locators';

export interface TestIdTransport {
  tag(req: TagRequest): Promise<TagResponse>;
  latest(): Promise<RegistrySnapshot | null>;
  diff(from: number, to: number, threshold?: number): Promise<DiffResult | null>;
  locators(target: LocatorTarget, attr?: string): Promise<Record<string, string> | null>;
  /** Registry maintenance (embedded transport only; HttpTransport throws). */
  rollback?(): Promise<{ from: number; to: number } | null>;
  activity?(): Promise<ActivityEntry[]>;
}

/** In-process. Zero setup — just give it a storage (in-memory or JSON-file). */
export class LocalTransport implements TestIdTransport {
  private service: TestIdService;
  constructor(storageOrService: RegistryStorage | TestIdService) {
    this.service = storageOrService instanceof TestIdService
      ? storageOrService
      : new TestIdService(storageOrService);
  }
  tag(req: TagRequest) { return this.service.tag(req); }
  latest() { return this.service.latest(); }
  diff(from: number, to: number, threshold = 0.8) { return this.service.diff(from, to, threshold); }
  locators(target: LocatorTarget, attr?: string) { return this.service.locators(target, attr); }
  rollback() { return this.service.rollback(); }
  activity() { return this.service.activity(); }
}

/** Remote. Uses global fetch (Node 18+), so still zero dependencies. */
export class HttpTransport implements TestIdTransport {
  constructor(private baseUrl: string) { this.baseUrl = baseUrl.replace(/\/$/, ''); }

  private async getOrNull<T>(path: string): Promise<T | null> {
    const res = await fetch(this.baseUrl + path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json() as Promise<T>;
  }

  async tag(req: TagRequest): Promise<TagResponse> {
    const res = await fetch(this.baseUrl + '/tag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`/tag -> ${res.status}`);
    return res.json() as Promise<TagResponse>;
  }
  latest() { return this.getOrNull<RegistrySnapshot>('/registry/latest'); }
  diff(from: number, to: number, threshold = 0.8) {
    return this.getOrNull<DiffResult>(`/diff?from=${from}&to=${to}&threshold=${threshold}`);
  }
  locators(target: LocatorTarget, attr?: string) {
    return this.getOrNull<Record<string, string>>(`/locators?target=${target}${attr ? `&attr=${attr}` : ''}`);
  }
}

/**
 * Factory: pick the mode from a single option.
 *   createTransport()                              -> in-memory, embedded (tests/demo)
 *   createTransport({ registryDir: './...' })      -> file-backed, embedded (CLI default)
 *   createTransport({ server: 'http://host:7337' }) -> remote service
 */
export function createTransport(opts: { server?: string; registryDir?: string } = {}): TestIdTransport {
  if (opts.server) return new HttpTransport(opts.server);
  // Lazy require to avoid pulling fs into purely in-memory consumers.
  const { JsonFileStorage, InMemoryStorage } = require('../registry/storage');
  return new LocalTransport(opts.registryDir ? new JsonFileStorage(opts.registryDir) : new InMemoryStorage());
}
