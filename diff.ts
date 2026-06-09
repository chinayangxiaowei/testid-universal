/**
 * Diff engine.
 *
 * Compares two snapshots and classifies every transition. The interesting cases
 * (renamed, modified) are only possible because of the fingerprint: a rename is
 * "id changed but fingerprint nearly identical", a modify is "id same, fingerprint
 * changed". Rename detection uses a normalized edit-distance similarity gated by a
 * threshold (default 0.8), exactly the knob the original tool exposes.
 */
import { RegistrySnapshot } from './storage';

export interface RenamePair { old_id: string; new_id: string; confidence: number; component: string; }
export interface ModifyPair { id: string; component: string; old_fingerprint: string; new_fingerprint: string; }

export interface DiffResult {
  from_version: number;
  to_version: number;
  summary: { unchanged: number; added: number; removed: number; renamed: number; modified: number; regenerated: number };
  added: { id: string; component: string }[];
  removed: { id: string; component: string }[];
  renamed: RenamePair[];
  modified: ModifyPair[];
  regenerated: { id: string; component: string }[];
}

/** Normalized Levenshtein similarity in [0,1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[n] / Math.max(m, n);
}

export function diff(from: RegistrySnapshot, to: RegistrySnapshot, threshold = 0.8): DiffResult {
  const fromIds = new Set(Object.keys(from.entries));
  const toIds = new Set(Object.keys(to.entries));

  const result: DiffResult = {
    from_version: from.version, to_version: to.version,
    summary: { unchanged: 0, added: 0, removed: 0, renamed: 0, modified: 0, regenerated: 0 },
    added: [], removed: [], renamed: [], modified: [], regenerated: [],
  };

  // Same id present in both -> unchanged or modified (by fingerprint).
  for (const id of toIds) {
    if (fromIds.has(id)) {
      const a = from.entries[id], b = to.entries[id];
      if (a.fingerprint === b.fingerprint) result.summary.unchanged++;
      else result.modified.push({ id, component: b.component, old_fingerprint: a.fingerprint, new_fingerprint: b.fingerprint });
    }
  }

  // Candidate adds/removes are ids on only one side.
  const candidateRemoved = [...fromIds].filter((id) => !toIds.has(id));
  const candidateAdded = [...toIds].filter((id) => !fromIds.has(id));

  // Rename detection: pair removed<->added by fingerprint similarity, greedily, best-first.
  const usedAdded = new Set<string>();
  for (const oldId of candidateRemoved) {
    let best: { id: string; conf: number } | null = null;
    for (const newId of candidateAdded) {
      if (usedAdded.has(newId)) continue;
      const conf = similarity(from.entries[oldId].fingerprint, to.entries[newId].fingerprint);
      if (conf >= threshold && (!best || conf > best.conf)) best = { id: newId, conf };
    }
    if (best) {
      usedAdded.add(best.id);
      result.renamed.push({ old_id: oldId, new_id: best.id, confidence: Math.round(best.conf * 100) / 100, component: to.entries[best.id].component });
    } else {
      result.removed.push({ id: oldId, component: from.entries[oldId].component });
    }
  }

  // Remaining unmatched adds. An add whose generation_history shows a prior version is "regenerated".
  for (const newId of candidateAdded) {
    if (usedAdded.has(newId)) continue;
    const e = to.entries[newId];
    if ((e.generation_history?.length ?? 0) > 1) result.regenerated.push({ id: newId, component: e.component });
    else result.added.push({ id: newId, component: e.component });
  }

  result.summary.added = result.added.length;
  result.summary.removed = result.removed.length;
  result.summary.renamed = result.renamed.length;
  result.summary.modified = result.modified.length;
  result.summary.regenerated = result.regenerated.length;
  return result;
}

/** Render a diff as PR-friendly Markdown. */
export function diffToMarkdown(d: DiffResult): string {
  const L: string[] = [];
  L.push(`# TestID Diff: v${d.from_version} -> v${d.to_version}`, '');
  L.push('| Category | Count |', '| --- | ---: |');
  for (const k of ['unchanged', 'added', 'removed', 'renamed', 'modified', 'regenerated'] as const) {
    L.push(`| ${k} | ${d.summary[k]} |`);
  }
  if (d.renamed.length) {
    L.push('', '## Renamed', '| Old | New | Confidence | Component |', '| --- | --- | ---: | --- |');
    for (const r of d.renamed) L.push(`| \`${r.old_id}\` | \`${r.new_id}\` | ${r.confidence} | ${r.component} |`);
  }
  if (d.modified.length) {
    L.push('', '## Modified', '| ID | Component |', '| --- | --- |');
    for (const m of d.modified) L.push(`| \`${m.id}\` | ${m.component} |`);
  }
  if (d.added.length) {
    L.push('', '## Added', '| ID | Component |', '| --- | --- |');
    for (const a of d.added) L.push(`| \`${a.id}\` | ${a.component} |`);
  }
  return L.join('\n') + '\n';
}
