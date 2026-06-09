/**
 * Deterministic diff. Elements are matched across versions by their stable
 * `identity` (exact equality) — never by fuzzy similarity. A copy edit keeps
 * the same identity and surfaces as `modified` with the exact list of changed
 * fingerprint fields, so the element is still locatable and you only revisit a
 * test when an asserted field changed.
 */
import { RegistrySnapshot } from './storage';
import { NormalizedSignals } from '../core/types';

export interface SignalChange { field: string; old: string | null; new: string | null }
export interface ModifyEntry { id: string; identity: string; component: string; changes: SignalChange[] }
export interface SimpleEntry { id: string; identity: string; component: string }

export interface DiffResult {
  from_version: number;
  to_version: number;
  summary: { unchanged: number; added: number; removed: number; modified: number; regenerated: number };
  added: SimpleEntry[];
  removed: SimpleEntry[];
  modified: ModifyEntry[];
  regenerated: SimpleEntry[];
}

function scalarFields(s: NormalizedSignals): Record<string, string | null> {
  return {
    explicit_key: s.explicit_key, form_control: s.form_control, name: s.name, route: s.route,
    html_id: s.html_id, text: s.text, aria_label: s.aria_label, placeholder: s.placeholder,
    title: s.title, alt: s.alt, value: s.value, type: s.type, role: s.role,
  };
}

function mapFields(s: NormalizedSignals): Record<string, string> {
  const ser = (m: Record<string, string>) => Object.keys(m).sort().map((k) => `${k}=${m[k]}`).join(',');
  return {
    event_handlers: ser(s.event_handlers),
    bound_identifiers: ser(s.bound_identifiers),
    structural: ser(s.structural),
    context: ser(s.context),
    child_shape: s.child_shape.join(','),
    semantic_css: s.semantic_css.join(','),
  };
}

export function diffSignals(a: NormalizedSignals, b: NormalizedSignals): SignalChange[] {
  const changes: SignalChange[] = [];
  const as = scalarFields(a), bs = scalarFields(b);
  for (const field of Object.keys(as)) {
    if (as[field] !== bs[field]) changes.push({ field, old: as[field], new: bs[field] });
  }
  const am = mapFields(a), bm = mapFields(b);
  for (const field of Object.keys(am)) {
    if (am[field] !== bm[field]) changes.push({ field, old: am[field] || null, new: bm[field] || null });
  }
  return changes;
}

export function diff(from: RegistrySnapshot, to: RegistrySnapshot): DiffResult {
  const added: SimpleEntry[] = [];
  const removed: SimpleEntry[] = [];
  const modified: ModifyEntry[] = [];
  const regenerated: SimpleEntry[] = [];
  let unchanged = 0;

  for (const [id, entry] of Object.entries(to.entries)) {
    const prev = from.entries[id];
    if (prev) {
      if (prev.fingerprint === entry.fingerprint) unchanged++;
      else modified.push({ id, identity: entry.identity, component: entry.component, changes: diffSignals(prev.signals, entry.signals) });
    } else if ((entry.generation_history?.length ?? 0) > 1) {
      regenerated.push({ id, identity: entry.identity, component: entry.component });
    } else {
      added.push({ id, identity: entry.identity, component: entry.component });
    }
  }
  for (const [id, entry] of Object.entries(from.entries)) {
    if (!to.entries[id]) removed.push({ id, identity: entry.identity, component: entry.component });
  }

  const cmp = (a: SimpleEntry, b: SimpleEntry) => a.id.localeCompare(b.id);
  added.sort(cmp); removed.sort(cmp); regenerated.sort(cmp);
  modified.sort((a, b) => a.id.localeCompare(b.id));

  return {
    from_version: from.version, to_version: to.version,
    summary: { unchanged, added: added.length, removed: removed.length, modified: modified.length, regenerated: regenerated.length },
    added, removed, modified, regenerated,
  };
}

export function diffToMarkdown(d: DiffResult): string {
  const L: string[] = [`# TestID Diff: v${d.from_version} -> v${d.to_version}`, '',
    '| Category | Count |', '| --- | ---: |'];
  for (const k of ['unchanged', 'added', 'removed', 'modified', 'regenerated'] as const) {
    L.push(`| ${k} | ${d.summary[k]} |`);
  }
  if (d.modified.length) {
    L.push('', '## Modified', '| ID | Changed fields |', '| --- | --- |');
    for (const m of d.modified) L.push(`| \`${m.id}\` | ${m.changes.map((c) => c.field).join(', ')} |`);
  }
  if (d.added.length) {
    L.push('', '## Added', '| ID |', '| --- |');
    for (const a of d.added) L.push(`| \`${a.id}\` |`);
  }
  if (d.removed.length) {
    L.push('', '## Removed', '| ID |', '| --- |');
    for (const r of d.removed) L.push(`| \`${r.id}\` |`);
  }
  return L.join('\n') + '\n';
}
