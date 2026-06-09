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
import { ElementNode, EntryDraft, CoreConfig, DEFAULT_CONFIG, generate } from '../core';
import { RegistryStorage, RegistrySnapshot, reconcile, diff, DiffResult, generateLocatorsSafe } from './_reexport';

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
}

export class TestIdService {
  constructor(private storage: RegistryStorage) {}

  private merge(partial?: Partial<CoreConfig>): CoreConfig {
    return { ...DEFAULT_CONFIG, ...(partial ?? {}) };
  }

  /** The main entry point: accept IR, assign ids, persist a new registry version, return edits. */
  async tag(req: TagRequest): Promise<TagResponse> {
    const config = this.merge(req.config);
    const drafts: EntryDraft[] = generate(req.nodes, config);
    const { snapshot, overrides } = await reconcile(drafts, this.storage);

    const edits: Edit[] = drafts
      .filter((d) => d.loc)
      .map((d) => ({ loc: d.loc!, attributeName: config.attributeName, id: d.id }));

    return {
      version: snapshot.version,
      assignments: drafts.map((d) => ({ fingerprint: d.fingerprint, id: d.id, component: d.component })),
      edits,
      overrides,
    };
  }

  async latest(): Promise<RegistrySnapshot | null> {
    return this.storage.loadLatest();
  }

  async diff(fromVersion: number, toVersion: number, threshold = 0.8): Promise<DiffResult | null> {
    const a = await this.storage.loadVersion(fromVersion);
    const b = await this.storage.loadVersion(toVersion);
    if (!a || !b) return null;
    return diff(a, b, threshold);
  }

  async locators(target: 'robot' | 'playwright' | 'cypress', attributeName?: string): Promise<Record<string, string> | null> {
    const latest = await this.storage.loadLatest();
    if (!latest) return null;
    return generateLocatorsSafe(latest, target, attributeName);
  }
}
