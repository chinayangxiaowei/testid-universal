import { NormalizedSignals } from './types';
import { slugify } from './semantic';

export type IdentitySource =
  | 'explicit_key' | 'form_control' | 'name' | 'route'
  | 'event_handlers' | 'bound_identifiers' | 'html_id' | 'structural'
  | 'child_shape' | 'text' | 'aria_label' | 'placeholder' | 'tag';

/** Sources whose value is volatile display copy (or the bare tag fallback). */
const UNSTABLE_SOURCES: ReadonlySet<IdentitySource> = new Set(['text', 'aria_label', 'placeholder', 'tag']);

function preferredMapValue(m: Record<string, string>, preferred: string[]): string | null {
  for (const k of preferred) if (m[k]) return m[k];
  const keys = Object.keys(m).sort();
  return keys.length ? m[keys[0]]! : null;
}

/** Ordered extractors: first non-empty wins. html_id is intentionally low. */
function valueForSource(sig: NormalizedSignals, source: IdentitySource): string | null {
  switch (source) {
    case 'explicit_key': return sig.explicit_key;
    case 'form_control': return sig.form_control;
    case 'name': return sig.name;
    case 'route': return sig.route;
    case 'event_handlers': return preferredMapValue(sig.event_handlers, ['click', 'submit', 'change', 'input']);
    case 'bound_identifiers': return preferredMapValue(sig.bound_identifiers, ['data', 'value', 'model', 'item', 'items']);
    case 'html_id': return sig.html_id;
    case 'structural': return preferredMapValue(sig.structural, ['ngif', 'ngfor', 'if', 'for']);
    case 'child_shape': return sig.child_shape.length ? sig.child_shape.join('-') : null;
    case 'text': return sig.text;
    case 'aria_label': return sig.aria_label;
    case 'placeholder': return sig.placeholder;
    case 'tag': return null;
  }
}

export const IDENTITY_KEY_PRIORITY: readonly IdentitySource[] = [
  'explicit_key', 'form_control', 'name', 'route', 'event_handlers',
  'bound_identifiers', 'html_id', 'structural', 'child_shape',
  'text', 'aria_label', 'placeholder',
];

export interface IdentityKey { value: string; source: IdentitySource; stable: boolean }

export function selectIdentityKey(sig: NormalizedSignals, tag: string): IdentityKey {
  for (const source of IDENTITY_KEY_PRIORITY) {
    const v = valueForSource(sig, source);
    if (v != null && v.length > 0) return { value: v, source, stable: !UNSTABLE_SOURCES.has(source) };
  }
  return { value: tag, source: 'tag', stable: false };
}

/** The stable matching key (no disambiguator). */
export function identityOf(component: string, elementShort: string, identityKey: string): string {
  return `${slugify(component)}::${slugify(elementShort)}::${slugify(identityKey)}`;
}
