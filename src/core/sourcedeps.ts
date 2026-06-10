/**
 * Source-dependency policy (L2 of the dual-map spec §3.3).
 *
 * Core owns WHICH symbols an element depends on and HOW their definitions are
 * normalized + hashed. Adapters only resolve names to raw definition source text
 * (FrameworkAdapter.resolveSymbolDefs) — they can never fabricate hashes, keeping
 * the re-test trigger as tamper-proof as identity itself.
 *
 * Normalization is whitespace-collapse only; comments are intentionally NOT
 * stripped (naive stripping can corrupt string literals and silently under-flag).
 * A comment edit therefore over-flags a re-test — the safe direction.
 */
import { createHash } from 'node:crypto';
import { NormalizedSignals } from './types';

/** Leading identifier of an expression path: "order.customer.name" -> "order". */
function rootIdentifier(expr: string): string | null {
  const m = /^[A-Za-z_$][\w$]*/.exec(expr.trim());
  return m ? m[0] : null;
}

/** The symbol names an element's code-wired signals reference (sorted, deduped). */
export function referencedSymbolNames(sig: NormalizedSignals): string[] {
  const names = new Set<string>();
  for (const v of Object.values(sig.event_handlers)) {
    const r = rootIdentifier(v);
    if (r) names.add(r);
  }
  for (const v of Object.values(sig.bound_identifiers)) {
    const r = rootIdentifier(v);
    if (r) names.add(r);
  }
  if (sig.form_control) {
    const r = rootIdentifier(sig.form_control);
    if (r) names.add(r);
  }
  return [...names].sort();
}

/** Normalize a definition's source text: collapse all whitespace runs, trim. */
function normalizeDefText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Hash resolved definition sources; unresolved (null) entries are skipped. */
export function hashSymbolSources(sources: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(sources).sort()) {
    const text = sources[name];
    if (text == null) continue;
    out[name] = createHash('sha256').update(normalizeDefText(text), 'utf8').digest('hex').slice(0, 12);
  }
  return out;
}
