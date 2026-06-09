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
}


export async function reconcile(
  drafts: EntryDraft[],
  storage: RegistryStorage,
  now: string = new Date().toISOString(),
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
    const wasPresentLast = existing?.last_seen_version === prev?.version;

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
      signals: d.signals,
      source,
      first_seen_version: existing?.first_seen_version ?? version,
      last_seen_version: version,
      last_generated_at: now,
      generation_history: history,
    };
  }

  // Carry forward tombstones for ids no longer present, preserving their last-seen
  // state untouched (last_seen_version stays at the version they last appeared in).
  // This is what lets a later comeback be recognized as a regeneration.
  const retired: Record<string, RegistryEntry> = {};
  for (const [id, e] of [...Object.entries(prevEntries), ...Object.entries(prevRetired)]) {
    if (!draftIds.has(id)) retired[id] = e;
  }

  const snapshot: RegistrySnapshot = { version, generated_at: now, entries, retired };
  await storage.save(snapshot);
  return { snapshot, overrides };
}
