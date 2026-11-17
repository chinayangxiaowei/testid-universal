import { ElementNode, EntryDraft, CoreConfig, Warning, PriorEntry, TagStats } from './types';
import { normalizeSignals } from './signals';
import { classify } from './classify';
import { slugify } from './semantic';
import { selectIdentityKey, identityOf } from './identity';
import { fingerprintOf } from './fingerprint';
import { formatId } from './format';
import { hashSymbolSources } from './sourcedeps';

function skippedByPolicy(node: ElementNode, config: CoreConfig): boolean {
  const tag = node.tag;
  if (config.ignoreTags.includes(tag) || config.ignoreTags.includes(tag.toLowerCase())) return true;
  // Copy-only presentation tags are skipped for fresh minting; an explicit key or an
  // already-written id (sticky) always wins, so nothing previously tagged is retired.
  return config.skipTags.includes(tag.toLowerCase()) && !node.existingId && !node.signals.explicit_key;
}

function hasAnySignal(node: ElementNode): boolean {
  if (node.existingId) return true;
  return Object.values(node.signals).some((v) => {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return Object.keys(v).length > 0;
  });
}

export function shouldTag(node: ElementNode, config: CoreConfig): boolean {
  return !skippedByPolicy(node, config) && hasAnySignal(node);
}

export interface GenerateResult { drafts: EntryDraft[]; warnings: Warning[]; stats: TagStats }

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
  const stats: TagStats = { elements: 0, tagged: 0, skipped_no_signal: 0, skipped_policy: 0 };

  for (const node of nodes) {
    stats.elements++;
    if (skippedByPolicy(node, config)) { stats.skipped_policy++; continue; }
    if (!hasAnySignal(node)) { stats.skipped_no_signal++; continue; }
    const sig = normalizeSignals(node.signals);
    const { short, long } = classify(node.tag, sig, config);
    let key = selectIdentityKey(sig, node.tag);
    // A key whose slug is empty (e.g. punctuation-only text) would mint ids ending in
    // "--" and collide; fall back to the tag, marked unstable.
    if (!slugify(key.value)) key = { value: node.tag, source: 'tag', stable: false };
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
      ...(p.node.dep_sources ? { dep_defs: hashSymbolSources(p.node.dep_sources) } : {}),
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
  stats.tagged = drafts.length;

  // Cross-file component reuse: a component instantiated N>=2 times means every
  // static id inside it appears N times in the rendered DOM (the loop warning's
  // cross-file sibling). Only custom-looking tags (an uppercase letter or a
  // hyphen) count as instantiations -- a component file named Button must never
  // match native <button> elements. Angular selectors commonly prefix `app-`.
  const normName = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const idsPerComponent = new Map<string, number>();
  for (const d of drafts) idsPerComponent.set(d.component, (idsPerComponent.get(d.component) ?? 0) + 1);
  const byNorm = new Map<string, string>();
  for (const c of new Set(nodes.map((n) => n.component))) {
    byNorm.set(normName(c), c);
    byNorm.set(`app${normName(c)}`, c);
  }
  const uses = new Map<string, number>();
  for (const n of nodes) {
    if (!/[A-Z-]/.test(n.tag)) continue;
    const c = byNorm.get(normName(n.tag));
    if (c != null) uses.set(c, (uses.get(c) ?? 0) + 1);
  }
  for (const [c, count] of uses) {
    const ids = idsPerComponent.get(c) ?? 0;
    if (count >= 2 && ids > 0) {
      warnings.push({
        code: 'component-multiplicity', element_type: 'component', identity: c,
        message: `component "${c}" is instantiated ${count} times across the tagged files; each of its ${ids} static testid(s) will appear ${count} times in the DOM. Scope queries to an instance container or bind per-instance ids.`,
      });
    }
  }

  return { drafts, warnings, stats };
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
