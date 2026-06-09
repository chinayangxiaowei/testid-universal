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
    if (!key.stable) {
      warnings.push({
        code: 'unstable-identity', element_type: long, identity,
        message: `identity for ${identity} comes from "${key.source}" (volatile); add an explicit ${config.explicitKeyAttribute} key for a stable testid`,
      });
    }
    pre.push({ node, short, long, identityKey: key.value, stable: key.stable, fingerprint: fingerprintOf(node.tag, sig), identity });
  }

  const byIdentity = new Map<string, Pre[]>();
  for (const p of pre) {
    if (!byIdentity.has(p.identity)) byIdentity.set(p.identity, []);
    byIdentity.get(p.identity)!.push(p);
  }

  const drafts: EntryDraft[] = [];
  for (const p of pre) {
    const group = byIdentity.get(p.identity)!;
    let disambiguator = '';
    if (group.length > 1) {
      disambiguator = disambiguate(p, group, warnings);
    }
    const sig = normalizeSignals(p.node.signals);
    drafts.push({
      id: formatId(config.idFormat, {
        component: p.node.component, element: p.short, key: slugify(p.identityKey), tag: p.node.tag, disambiguator,
      }),
      component: p.node.component,
      tag: p.node.tag,
      element_type: p.long,
      identity: p.identity,
      identity_key: slugify(p.identityKey),
      fingerprint: p.fingerprint,
      signals: sig,
      loc: p.node.loc,
    });
  }
  return { drafts, warnings };
}

/** Prefer a distinguishing stable token; else a positional index (1-based) + warning. */
function disambiguate(p: Pre, group: Pre[], warnings: Warning[]): string {
  const sig = normalizeSignals(p.node.signals);
  const stableToken = sig.html_id ?? sig.route ?? Object.values(sig.bound_identifiers)[0] ?? null;
  if (stableToken) {
    const distinct = new Set(group.map((g) => {
      const gs = normalizeSignals(g.node.signals);
      return gs.html_id ?? gs.route ?? Object.values(gs.bound_identifiers)[0] ?? '';
    }));
    if (distinct.size === group.length) return slugify(stableToken);
  }
  const index = group.indexOf(p) + 1;
  warnings.push({
    code: 'positional-disambiguator', element_type: p.long, identity: p.identity,
    message: `${p.identity} has ${group.length} indistinguishable elements; using positional index ${index}. Add an explicit key for stable ids.`,
  });
  return index === 1 ? '' : String(index);
}
