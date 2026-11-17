/**
 * Client pipeline — orchestrates one adapter against a transport.
 *
 *   source --parse--> IR --transport.tag--> ids + edits --write--> tagged source
 *
 * The transport may be LocalTransport (in-process, no server) or HttpTransport
 * (remote). The pipeline cannot tell the difference — that is the whole point.
 */
import { CoreConfig, Warning, TagStats } from '../core/types';
import { normalizeSignals, referencedSymbolNames } from '../core';
import { FrameworkAdapter } from '../adapters/contract';
import { TestIdTransport } from './transport';
import { ModuleGraph } from './deps';

/** Layer-2 dep tracking report: whether it ran, and what could not be resolved. */
export interface DepStats { enabled: boolean; tracked: number; unresolved: string[] }

export interface TaggedFile { file: string; before: string; after: string; }

export async function runPipeline(
  adapter: FrameworkAdapter,
  transport: TestIdTransport,
  files: { file: string; component: string; source: string }[],
  config?: Partial<CoreConfig>,
  opts?: { regenerate?: boolean; /** layer-2 dep tracking; default ON, false = --no-deps */ deps?: boolean },
): Promise<{ tagged: TaggedFile[]; version: number; overrides: string[]; warnings: Warning[]; stats: TagStats; outOfScope: number; deps: DepStats }> {
  const depsOn = opts?.deps !== false && typeof adapter.scriptContext === 'function';
  const graph = depsOn ? new ModuleGraph() : null;
  const depStats: DepStats = { enabled: depsOn, tracked: 0, unresolved: [] };
  // 1. Parse every file into the shared IR (the only framework-aware step).
  const parsed = files.flatMap((f) => {
    const fileNodes = adapter.parse(f.source, f.file, f.component);
    // L2 source-deps: resolve each file's referenced symbols once, then attach the
    // per-node subset. Core picks the names and hashes the text; the adapter only maps
    // name -> raw definition source. Adapters without the capability skip this.
    if (adapter.resolveSymbolDefs) {
      const perNode = fileNodes.map((n) => referencedSymbolNames(normalizeSignals(n.signals)));
      const all = [...new Set(perNode.flat())].sort();
      if (all.length) {
        const resolved = adapter.resolveSymbolDefs(all, f.source, f.file);
        fileNodes.forEach((n, i) => {
          if (!perNode[i].length) return;
          const subset: Record<string, string | null> = {};
          for (const name of perNode[i]) subset[name] = resolved[name] ?? null;
          n.symbol_sources = subset;
        });
      }
    }
    // Layer 2: one hop past each referenced symbol (shared JS/TS resolver). Every
    // node gets a dep_sources map (possibly empty) so its entry records a baseline.
    if (graph) {
      const perNode = fileNodes.map((n) => referencedSymbolNames(normalizeSignals(n.signals)));
      const all = [...new Set(perNode.flat())].sort();
      const ctx = all.length ? adapter.scriptContext!(f.source, f.file) : null;
      const res = ctx ? graph.resolve(all, ctx) : { byName: {}, unresolved: [] };
      depStats.unresolved.push(...res.unresolved);
      fileNodes.forEach((n, i) => {
        const deps: Record<string, string> = {};
        for (const name of perNode[i]) Object.assign(deps, res.byName[name] ?? {});
        depStats.tracked += Object.keys(deps).length;
        n.dep_sources = deps;
      });
    }
    return fileNodes;
  });
  // regenerate: drop existing ids so every element is freshly minted (and overwritten).
  const nodes = opts?.regenerate ? parsed.map((n) => ({ ...n, existingId: null })) : parsed;

  // 2. Ask the transport to assign ids + persist a registry version.
  const mergedConfig = {
    ...(config ?? {}),
    customTagMap: { ...(adapter.customTagMap ?? {}), ...(config?.customTagMap ?? {}) },
  };
  const resp = await transport.tag({ nodes, config: mergedConfig });

  // 3. Group edits per file and write them back via the adapter.
  const editsByFile = new Map<string, typeof resp.edits>();
  for (const e of resp.edits) {
    if (!editsByFile.has(e.loc.file)) editsByFile.set(e.loc.file, []);
    editsByFile.get(e.loc.file)!.push(e);
  }
  const tagged: TaggedFile[] = files.map((f) => ({
    file: f.file,
    before: f.source,
    after: adapter.write(f.source, editsByFile.get(f.file) ?? []),
  }));

  return { tagged, version: resp.version, overrides: resp.overrides, warnings: resp.warnings, stats: resp.stats, outOfScope: resp.outOfScope ?? 0,
    deps: { ...depStats, unresolved: [...new Set(depStats.unresolved)].sort() } };
}

/** One CLI/CI line per warning, led by its code so logs can be filtered by category. */
export function formatWarning(w: Warning): string {
  return `[${w.code}] ${w.message}`;
}
