/**
 * Service — the backend's application core, independent of any transport.
 *
 * This object is what makes the whole idea a *backend* rather than a build script:
 * a single centralized brain that any client (Angular CLI plugin, Vue Vite plugin,
 * a React babel step, CI, a dashboard) can call over the wire. The contract is the
 * IR (ElementNode[]) in, assigned ids + edits out.
 *
 * Swap the storage for Postgres/Redis and this same service becomes a multi-repo,
 * multi-team testid authority.
 */
import { ElementNode, CoreConfig, DEFAULT_CONFIG, PriorEntry, generate, Warning, TagStats } from '../core';
import { RegistryStorage, RegistrySnapshot, RegistryConflictError, ActivityEntry, reconcile, diff, DiffResult, generateLocatorsSafe, LocatorTarget } from './_reexport';

export interface TagRequest {
  nodes: ElementNode[];
  config?: Partial<CoreConfig>;
}

export interface Edit { loc: NonNullable<ElementNode['loc']>; attributeName: string; id: string; }

export interface TagResponse {
  version: number;
  assignments: { fingerprint: string; id: string; component: string }[];
  edits: Edit[];          // what the adapter should write back into the source
  overrides: string[];    // manual ids that shadowed generated ones
  warnings: Warning[];
  stats: TagStats;
  /** Entries carried forward because their file was outside this (partial) run. */
  outOfScope: number;
}

export class TestIdService {
  constructor(private storage: RegistryStorage) {}

  private merge(partial?: Partial<CoreConfig>): CoreConfig {
    return { ...DEFAULT_CONFIG, ...(partial ?? {}) };
  }

  /**
   * The main entry point: accept IR, assign ids, persist a new registry version, return edits.
   * Concurrency: if another writer (or a rollback) moved the registry after we read it,
   * the save is rejected and the whole tag is redone on the new latest — concurrent tags
   * serialize into consecutive versions instead of overwriting each other.
   */
  async tag(req: TagRequest): Promise<TagResponse> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.tagOnce(req);
      } catch (e) {
        if (!(e instanceof RegistryConflictError) || attempt >= TestIdService.MAX_TAG_ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt)); // de-synchronize retries
      }
    }
  }

  static readonly MAX_TAG_ATTEMPTS = 8;

  private async tagOnce(req: TagRequest): Promise<TagResponse> {
    const config = this.merge(req.config);
    const prevSnap = await this.storage.loadLatest();
    const prior: PriorEntry[] | undefined = prevSnap
      ? [...Object.values(prevSnap.entries), ...Object.values(prevSnap.retired ?? {})]
          .filter((e) => e.identity != null) // legacy entries without identity can never match
          .map((e) => ({
            identity: e.identity, fingerprint: e.fingerprint, disambiguator: e.disambiguator ?? '',
          }))
      : undefined;
    const { drafts, warnings, stats } = generate(req.nodes, config, prior);
    // Scope = the files this request parsed; reconcile retires only within it.
    const scopeFiles = new Set(req.nodes.map((n) => n.loc?.file).filter((f): f is string => f != null));
    const { snapshot, overrides, outOfScope } = await reconcile(drafts, this.storage, undefined, { scopeFiles, base: prevSnap });

    const edits: Edit[] = drafts
      .filter((d) => d.loc)
      .map((d) => ({ loc: d.loc!, attributeName: config.attributeName, id: d.id }));

    return {
      version: snapshot.version,
      assignments: drafts.map((d) => ({ fingerprint: d.fingerprint, id: d.id, component: d.component })),
      edits,
      overrides,
      warnings,
      stats,
      outOfScope,
    };
  }

  async latest(): Promise<RegistrySnapshot | null> {
    return this.storage.loadLatest();
  }

  async diff(fromVersion: number, toVersion: number, _threshold = 0.8): Promise<DiffResult | null> {
    const a = await this.storage.loadVersion(fromVersion);
    const b = await this.storage.loadVersion(toVersion);
    if (!a || !b) return null;
    return diff(a, b);
  }

  async locators(target: LocatorTarget, attributeName?: string): Promise<Record<string, string> | null> {
    const latest = await this.storage.loadLatest();
    if (!latest) return null;
    return generateLocatorsSafe(latest, target, attributeName);
  }

  async rollback(): Promise<{ from: number; to: number } | null> {
    return this.storage.rollback();
  }

  async activity(): Promise<ActivityEntry[]> {
    return this.storage.activity();
  }
}
