/**
 * Engine — the pure, framework-agnostic pipeline.
 *
 *   ElementNode[]  ->  EntryDraft[]
 *
 * For each node: classify, extract key, fingerprint, format id. Then resolve
 * collisions: ids that collide but describe genuinely different elements (distinct
 * fingerprints) get a deterministic hash suffix; identical elements keep one id.
 *
 * This function is a PURE function of (nodes, config). Same input -> same output,
 * every run. No history, no I/O — that belongs to the registry layer.
 */
import { ElementNode, EntryDraft, CoreConfig } from './types';
import { classify } from './classify';
import { keyFor } from './semantic';
import { fingerprintOf, hashOf } from './fingerprint';
import { formatId } from './format';

export function shouldTag(node: ElementNode, config: CoreConfig): boolean {
  if (config.ignoreTags.includes(node.tag) || config.ignoreTags.includes(node.tag.toLowerCase())) {
    return false;
  }
  // A node is taggable if it carries ANY semantic signal, or already has an id.
  // Pure decorative wrappers (no semantics at all) are skipped — mirroring the
  // "wrapping layouts that carry no semantics are skipped" rule.
  if (node.existingId) return true;
  return Object.values(node.semantic).some((v) => v != null && String(v).trim() !== '');
}

export function generate(nodes: ElementNode[], config: CoreConfig): EntryDraft[] {
  const taggable = nodes.filter((n) => shouldTag(n, config));

  // Pass 1: compute everything except the hash suffix.
  type Pre = { node: ElementNode; element: string; long: string; key: string; fp: string; baseId: string };
  const pre: Pre[] = taggable.map((node) => {
    const cls = classify(node, config);
    const key = keyFor(node, config);
    const fp = fingerprintOf(node);
    const baseId = formatId(config.idFormat, {
      component: node.component, element: cls.short, key, tag: node.tag, hash: '',
    });
    return { node, element: cls.short, long: cls.long, key, fp, baseId };
  });

  // Pass 2: detect collisions on baseId across *distinct* fingerprints.
  const fpsByBase = new Map<string, Set<string>>();
  for (const p of pre) {
    if (!fpsByBase.has(p.baseId)) fpsByBase.set(p.baseId, new Set());
    fpsByBase.get(p.baseId)!.add(p.fp);
  }

  // Pass 3: emit drafts, adding a hash suffix only where a base id is contested.
  const out: EntryDraft[] = [];
  for (const p of pre) {
    const contested = (fpsByBase.get(p.baseId)?.size ?? 0) > 1;
    let hash = '';
    if (contested) {
      if (config.collisionStrategy === 'error') {
        throw new Error(`testid collision on "${p.baseId}" with distinct fingerprints`);
      }
      hash = hashOf(p.fp, config);
    }
    const id = formatId(config.idFormat, {
      component: p.node.component, element: p.element, key: p.key, tag: p.node.tag, hash,
    });
    out.push({
      id,
      component: p.node.component,
      tag: p.node.tag,
      element_type: p.long,
      fingerprint: p.fp,
      semantic: p.node.semantic,
      key: p.key,
      loc: p.node.loc,
    });
  }
  return out;
}
