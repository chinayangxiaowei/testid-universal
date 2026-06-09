import { RawSignals, NormalizedSignals } from './types';

function norm(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : null;
}

function normMap(name: string, m: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== 'string') throw new Error(`signals.${name}: value for "${k}" must be a string`);
    const nv = norm(v);
    if (nv) out[k.toLowerCase()] = nv;
  }
  return out;
}

function normList(arr: string[] | undefined, sortDedupe: boolean): string[] {
  if (!arr) return [];
  const cleaned = arr.map((s) => norm(s)).filter((s): s is string => s != null);
  if (!sortDedupe) return cleaned;
  return [...new Set(cleaned.map((s) => s.toLowerCase()))].sort();
}

export function normalizeSignals(raw: RawSignals): NormalizedSignals {
  return {
    explicit_key: norm(raw.explicit_key),
    form_control: norm(raw.form_control),
    name: norm(raw.name),
    route: norm(raw.route),
    event_handlers: normMap('event_handlers', raw.event_handlers),
    bound_identifiers: normMap('bound_identifiers', raw.bound_identifiers),
    html_id: norm(raw.html_id),
    structural: normMap('structural', raw.structural),
    child_shape: normList(raw.child_shape, false),
    context: normMap('context', raw.context),
    semantic_css: normList(raw.semantic_css, true),
    text: norm(raw.text),
    aria_label: norm(raw.aria_label),
    placeholder: norm(raw.placeholder),
    title: norm(raw.title),
    alt: norm(raw.alt),
    value: norm(raw.value),
    type: norm(raw.type),
    role: norm(raw.role),
    static_attributes: normMap('static_attributes', raw.static_attributes),
  };
}
