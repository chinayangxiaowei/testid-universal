/**
 * Fingerprint — the rich descriptive signature of "what this element is".
 *
 * Built from ALL signals (including display copy and static_attributes) in a
 * fixed canonical order, so reordering attributes never changes it. Used only
 * to detect `modified` and to report which fields changed — NEVER for matching.
 * Matching is by `identity` (see identity.ts), which excludes copy.
 */
import { NormalizedSignals } from './types';

function pushScalar(parts: string[], key: string, v: string | null) {
  if (v != null && v.length > 0) parts.push(`${key}=${v}`);
}
function pushMap(parts: string[], key: string, m: Record<string, string>) {
  for (const k of Object.keys(m).sort()) parts.push(`${key}.${k}=${m[k]}`);
}
function pushList(parts: string[], key: string, arr: string[]) {
  if (arr.length) parts.push(`${key}=${arr.join(',')}`);
}

export function fingerprintOf(tag: string, sig: NormalizedSignals): string {
  const parts: string[] = [tag.toLowerCase()];
  pushScalar(parts, 'explicit_key', sig.explicit_key);
  pushScalar(parts, 'form_control', sig.form_control);
  pushScalar(parts, 'name', sig.name);
  pushScalar(parts, 'route', sig.route);
  pushMap(parts, 'on', sig.event_handlers);
  pushMap(parts, 'bound', sig.bound_identifiers);
  pushScalar(parts, 'html_id', sig.html_id);
  pushMap(parts, 'struct', sig.structural);
  pushList(parts, 'child_shape', sig.child_shape);
  pushMap(parts, 'ctx', sig.context);
  pushList(parts, 'class', sig.semantic_css);
  pushScalar(parts, 'text', sig.text);
  pushScalar(parts, 'aria_label', sig.aria_label);
  pushScalar(parts, 'placeholder', sig.placeholder);
  pushScalar(parts, 'title', sig.title);
  pushScalar(parts, 'alt', sig.alt);
  pushScalar(parts, 'value', sig.value);
  pushScalar(parts, 'type', sig.type);
  pushScalar(parts, 'role', sig.role);
  pushMap(parts, 'attr', sig.static_attributes);
  return parts.join('|');
}
