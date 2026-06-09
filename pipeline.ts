/**
 * Client pipeline — orchestrates one adapter against the backend service.
 *
 *   source --parse--> IR --POST /tag--> assigned ids + edits --write--> tagged source
 *
 * The service can be in-process (as here) or remote over HTTP; the pipeline does
 * not care. This is the "thin client" every framework integration reduces to.
 */
import { CoreConfig } from '../core/types';
import { FrameworkAdapter } from '../adapters/contract';
import { TestIdService } from '../server/service';

export interface TaggedFile { file: string; before: string; after: string; }

export async function runPipeline(
  adapter: FrameworkAdapter,
  service: TestIdService,
  files: { file: string; component: string; source: string }[],
  config?: Partial<CoreConfig>,
): Promise<{ tagged: TaggedFile[]; version: number; overrides: string[] }> {
  // 1. Parse every file into the shared IR (the only framework-aware step).
  const nodes = files.flatMap((f) => adapter.parse(f.source, f.file, f.component));

  // 2. Ask the backend to assign ids and persist a registry version.
  const mergedConfig = { ...(config ?? {}), customTagMap: { ...(adapter.customTagMap ?? {}), ...(config?.customTagMap ?? {}) } };
  const resp = await service.tag({ nodes, config: mergedConfig });

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

  return { tagged, version: resp.version, overrides: resp.overrides };
}
