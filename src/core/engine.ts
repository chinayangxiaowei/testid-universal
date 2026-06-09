import { ElementNode, EntryDraft, CoreConfig, Warning } from './types';
import { normalizeSignals } from './signals';
import { classify } from './classify';
import { slugify } from './semantic';
import { selectIdentityKey, identityOf } from './identity';
import { fingerprintOf } from './fingerprint';
import { formatId } from './format';

export function shouldTag(node: ElementNode, config: CoreConfig): boolean {
  const tag = node.tag;
  if (config.ignoreTags.includes(tag) || config.ignoreTags.includes(tag.toLowerCase())) return false;
  if (node.existingId) return true;
  const s = node.signals;
  return Object.values(s).some((v) => {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return Object.keys(v).length > 0;
  });
}

export interface GenerateResult { drafts: EntryDraft[]; warnings: Warning[] }

interface Pre {
  node: ElementNode;
  short: string;
  long: string;
  identityKey: string;
  stable: boolean;
  fingerprint: string;
  identity: string;
}

export function generate(nodes: ElementNode[], config: CoreConfig): GenerateResult {
  const warnings: Warning[] = [];
  const pre: Pre[] = [];

  for (const node of nodes) {
    if (!shouldTag(node, config)) continue;
    const sig = normalizeSignals(node.signals);
    const { short, long } = classify(node.tag, sig, config);
    const key = selectIdentityKey(sig, node.tag);
    const identity = identityOf(node.component, short, key.value);
    // Only warn about a volatile key for elements that will be freshly minted; an
    // element that already carries a written id is sticky and is never recomputed.
    if (!key.stable && !node.existingId) {
      warnings.push({
        code: 'unstable-identity', element_type: long, identity,
        message: `identity for ${identity} comes from "${key.source}" (volatile); add an explicit ${config.explicitKeyAttribute} key for a stable testid`,
      });
    }
    if (node.inLoop) {
      warnings.push({
        code: 'loop-multiplicity', element_type: long, identity,
        message: `${identity} is inside a loop (v-for / *ngFor): one static id is shared by every rendered instance. Bind a per-item id instead (e.g. a :data-testid bound to the item's key).`,
      });
    }
    pre.push({ node, short, long, identityKey: key.value, stable: key.stable, fingerprint: fingerprintOf(node.tag, sig), identity });
  }

  // Sticky: elements that already carry a written id keep it verbatim. Reserve those
  // ids so freshly-minted ids can never collide with them.
  const taken = new Set<string>();
  for (const p of pre) if (p.node.existingId) taken.add(p.node.existingId);

  // Fresh elements (no written id) are grouped by identity for disambiguation.
  const freshByIdentity = new Map<string, Pre[]>();
  for (const p of pre) {
    if (p.node.existingId) continue;
    if (!freshByIdentity.has(p.identity)) freshByIdentity.set(p.identity, []);
    freshByIdentity.get(p.identity)!.push(p);
  }

  const drafts: EntryDraft[] = [];
  for (const p of pre) {
    const sig = normalizeSignals(p.node.signals);
    const common = {
      component: p.node.component, tag: p.node.tag, element_type: p.long,
      identity: p.identity, identity_key: slugify(p.identityKey),
      fingerprint: p.fingerprint, signals: sig, loc: p.node.loc,
    };

    if (p.node.existingId) {
      drafts.push({ id: p.node.existingId, sticky: true, ...common });
      continue;
    }

    const group = freshByIdentity.get(p.identity)!;
    const disambiguator = group.length > 1 ? disambiguate(p, group, warnings) : '';
    const render = (dis: string) => formatId(config.idFormat, {
      component: slugify(p.node.component), element: slugify(p.short),
      key: slugify(p.identityKey), tag: p.node.tag, disambiguator: dis,
    });
    let id = render(disambiguator);
    // Global uniqueness: never reuse an id already taken (sticky or an earlier mint).
    for (let n = 2; taken.has(id); n++) id = render(disambiguator ? `${disambiguator}-${n}` : String(n));
    taken.add(id);
    drafts.push({ id, sticky: false, ...common });
  }
  return { drafts, warnings };
}

/**
 * Group-coherent disambiguation. If EVERY member of the same-identity group has a
 * distinct, non-empty stable-token slug, use that slug for all members; otherwise
 * assign positional indices to all members (with a warning). Keeping the whole group
 * on one scheme guarantees a stable-token slug can never collide with a positional index.
 */
function disambiguate(p: Pre, group: Pre[], warnings: Warning[]): string {
  const slugTokens = group.map((g) => {
    const gs = normalizeSignals(g.node.signals);
    const tok = gs.html_id ?? gs.route ?? Object.values(gs.bound_identifiers)[0] ?? null;
    return tok ? slugify(tok) : null;
  });
  const allDistinctPresent = slugTokens.every((t): t is string => !!t) && new Set(slugTokens).size === group.length;
  if (allDistinctPresent) {
    return slugTokens[group.indexOf(p)]!;
  }
  const index = group.indexOf(p);
  warnings.push({
    code: 'positional-disambiguator', element_type: p.long, identity: p.identity,
    message: `${p.identity} has ${group.length} indistinguishable elements; using positional index ${index + 1}. Add an explicit key for stable ids.`,
  });
  return index === 0 ? '' : String(index + 1);
}
