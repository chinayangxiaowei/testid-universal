/**
 * Registry reconciliation.
 *
 * Takes the engine's pure drafts plus the previous snapshot and produces the next
 * versioned snapshot. This is where the "memory" lives: first/last-seen versions,
 * generated-vs-manual provenance, and regeneration history (an id that vanished
 * and later came back). None of this is framework-specific.
 */
import { EntryDraft } from '../core/types';
import { RegistrySnapshot, RegistryEntry, RegistryStorage } from './storage';

export interface ReconcileResult {
  snapshot: RegistrySnapshot;
  overrides: string[]; // ids where a manual entry shadowed a generated one
  /** Entries carried forward untouched because their file was outside this run's scope. */
  outOfScope: number;
}

export interface ReconcileOptions {
  /**
   * The files this run actually parsed. An absent id is retired ONLY when its
   * recorded file is in scope (the element really vanished); entries from files
   * outside the run are carried forward unchanged, so a partial tag run can
   * never mass-retire the rest of the registry. Legacy entries without a
   * recorded file keep the old retire-on-absence behavior (a full run upgrades
   * them by recording files).
   */
  scopeFiles?: Set<string>;
}

export async function reconcile(
  drafts: EntryDraft[],
  storage: RegistryStorage,
  now: string = new Date().toISOString(),
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const prev = await storage.loadLatest();
  const prevEntries = prev?.entries ?? {};
  const prevRetired = prev?.retired ?? {};
  const version = (prev?.version ?? 0) + 1;
  const overrides: string[] = [];
  const draftIds = new Set(drafts.map((d) => d.id));

  const entries: Record<string, RegistryEntry> = {};
  for (const d of drafts) {
    // Provenance survives a disappearance: an id absent for some versions still
    // lives in `retired`, so look there too before treating it as brand new.
    const existing = prevEntries[d.id] ?? prevRetired[d.id];
    const everSeen = existing != null;
    const wasPresentLast = prevEntries[d.id] != null;

    // Manual entries (someone hand-wrote this id) are preserved as 'manual'.
    let source: RegistryEntry['source'];
    if (existing?.source === 'manual') {
      source = 'manual';
      overrides.push(d.id);
    } else {
      source = d.sticky ? 'sticky' : 'generated';
    }

    // generation_history records every version in which the id was (re)created. A
    // regenerated id (seen before but not present in the previous version) gets the
    // current version appended.
    let history = existing?.generation_history ?? [];
    if (!everSeen || !wasPresentLast) history = [...history, version]; // first time or regenerated

    entries[d.id] = {
      component: d.component,
      tag: d.tag,
      element_type: d.element_type,
      identity: d.identity,
      fingerprint: d.fingerprint,
      disambiguator: d.disambiguator,
      symbol_defs: d.symbol_defs,
      signals: d.signals,
      file: d.loc?.file ?? existing?.file,
      source,
      first_seen_version: existing?.first_seen_version ?? version,
      last_seen_version: version,
      last_generated_at: now,
      generation_history: history,
    };
  }

  // Ids no longer present either retire (the element really vanished from a file
  // we parsed) or carry forward untouched (their file was outside this run's
  // scope). Tombstones preserve last-seen state so a comeback reads as regeneration.
  const retired: Record<string, RegistryEntry> = {};
  let outOfScope = 0;
  const scope = options.scopeFiles;
  for (const [id, e] of Object.entries(prevEntries)) {
    if (draftIds.has(id)) continue;
    if (scope && e.file && !scope.has(e.file)) {
      entries[id] = e; // out of scope: neither retired nor touched
      outOfScope++;
    } else {
      retired[id] = e;
    }
  }
  for (const [id, e] of Object.entries(prevRetired)) {
    if (!draftIds.has(id) && entries[id] == null) retired[id] = e;
  }

  const snapshot: RegistrySnapshot = { version, generated_at: now, entries, retired };
  await storage.save(snapshot);
  return { snapshot, overrides, outOfScope };
}
