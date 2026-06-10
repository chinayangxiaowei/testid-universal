import { ElementNode, EntryDraft, CoreConfig, Warning, PriorEntry } from './types';
import { normalizeSignals } from './signals';
import { classify } from './classify';
import { slugify } from './semantic';
import { selectIdentityKey, identityOf } from './identity';
import { fingerprintOf } from './fingerprint';
import { formatId } from './format';
import { hashSymbolSources } from './sourcedeps';

export function shouldTag(node: ElementNode, config: CoreConfig): boolean {
  const tag = node.tag;
  if (config.ignoreTags.includes(tag) || config.ignoreTags.includes(tag.toLowerCase())) return false;
  // Copy-only presentation tags are skipped for fresh minting; an explicit key or an
  // already-written id (sticky) always wins, so nothing previously tagged is retired.
  if (config.skipTags.includes(tag.toLowerCase()) && !node.existingId && !node.signals.explicit_key) {
    return false;
  }
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

export function generate(nodes: ElementNode[], config: CoreConfig, prior?: PriorEntry[]): GenerateResult {
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

  // Build a prior-entry index keyed by identity for registry-stable slot inheritance.
  const priorByIdentity = new Map<string, PriorEntry[]>();
  for (const e of prior ?? []) {
    if (!priorByIdentity.has(e.identity)) priorByIdentity.set(e.identity, []);
    priorByIdentity.get(e.identity)!.push(e);
  }

  // Pre-compute disambiguator slots for every multi-member fresh group.
  const slots = new Map<Pre, string>();
  for (const [identity, group] of freshByIdentity) {
    if (group.length > 1) assignGroupSlots(group, priorByIdentity.get(identity) ?? [], warnings, slots);
  }

  const drafts: EntryDraft[] = [];
  for (const p of pre) {
    const sig = normalizeSignals(p.node.signals);
    const common = {
      component: p.node.component, tag: p.node.tag, element_type: p.long,
      identity: p.identity, identity_key: slugify(p.identityKey),
      fingerprint: p.fingerprint, signals: sig, loc: p.node.loc,
      symbol_defs: hashSymbolSources(p.node.symbol_sources ?? {}),
    };

    if (p.node.existingId) {
      drafts.push({ id: p.node.existingId, sticky: true, disambiguator: '', ...common });
      continue;
    }

    const disambiguator = slots.get(p) ?? '';
    const render = (dis: string) => formatId(config.idFormat, {
      component: slugify(p.node.component), element: slugify(p.short),
      key: slugify(p.identityKey), tag: p.node.tag, disambiguator: dis,
    });
    let id = render(disambiguator);
    // Global uniqueness: never reuse an id already taken (sticky or an earlier mint).
    for (let n = 2; taken.has(id); n++) id = render(disambiguator ? `${disambiguator}-${n}` : String(n));
    taken.add(id);
    drafts.push({ id, sticky: false, disambiguator, ...common });
  }
  return { drafts, warnings };
}

/**
 * Group-coherent slot assignment. Stable-token path first (all members carry
 * distinct non-empty stable-token slugs). Otherwise positional — but registry-
 * stable: a member whose fingerprint matches a prior same-identity entry
 * byte-exact inherits that entry's old suffix, so reordering/inserting siblings
 * never shifts an incumbent. Only genuinely new members take the next free slot.
 */
function assignGroupSlots(group: Pre[], prior: PriorEntry[], warnings: Warning[], out: Map<Pre, string>): void {
  const slugTokens = group.map((g) => {
    const gs = normalizeSignals(g.node.signals);
    const tok = gs.html_id ?? gs.route ?? Object.values(gs.bound_identifiers)[0] ?? null;
    return tok ? slugify(tok) : null;
  });
  const allDistinctPresent = slugTokens.every((t): t is string => !!t) && new Set(slugTokens).size === group.length;
  if (allDistinctPresent) {
    group.forEach((g, i) => out.set(g, slugTokens[i]!));
    return;
  }
  // Sort prior by disambiguator: '' first, then numeric ascending, then lexicographic.
  prior = [...prior].sort((a, b) => (a.disambiguator === '' ? -1 : b.disambiguator === '' ? 1 : a.disambiguator.localeCompare(b.disambiguator, undefined, { numeric: true })));
  const claimed = new Set<string>();
  const unassigned: Pre[] = [];
  // Phase 1: inherit a prior slot whose fingerprint matches byte-exact (lowest unclaimed first).
  for (const g of group) {
    const match = prior.find((e) => e.fingerprint === g.fingerprint && !claimed.has(e.disambiguator));
    if (match) { out.set(g, match.disambiguator); claimed.add(match.disambiguator); }
    else unassigned.push(g);
  }
  // Phase 2: new members take the next free positional slot ('' is slot 1).
  let n = 1;
  for (const g of unassigned) {
    let value = n === 1 ? '' : String(n);
    while (claimed.has(value)) { n++; value = n === 1 ? '' : String(n); }
    out.set(g, value); claimed.add(value); n++;
  }
  for (const g of group) {
    warnings.push({
      code: 'positional-disambiguator', element_type: g.long, identity: g.identity,
      message: `${g.identity} has ${group.length} indistinguishable elements; using positional slots. Add an explicit key for fully stable ids.`,
    });
  }
}
