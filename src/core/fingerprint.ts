/**
 * Fingerprint — the deterministic signature of "what this element IS".
 *
 * The id answers "what is it called"; the fingerprint answers "what is it".
 * Decoupling the two is what lets the diff engine tell a *rename* (same element,
 * new name) from an *add+remove*, and a *modification* (same name, changed nature)
 * apart. The fingerprint is built in a fixed canonical order so it is stable
 * regardless of authoring order, across runs and across machines.
 */
import { createHash } from 'node:crypto';
import { ElementNode, SemanticHints, CoreConfig } from './types';

// Fixed order — NOT the key-priority order. Order here only affects the string form,
// and must never change casually or every fingerprint in existing registries shifts.
const FINGERPRINT_ORDER: (keyof SemanticHints)[] = [
  'type', 'field_name', 'name', 'aria_label', 'placeholder', 'route', 'role', 'text_content',
];

export function fingerprintOf(node: ElementNode): string {
  const parts: string[] = [node.tag];
  for (const field of FINGERPRINT_ORDER) {
    const v = node.semantic[field];
    if (v != null && String(v).trim() !== '') parts.push(`${field}=${String(v).trim()}`);
  }
  if (node.extraAttrs) {
    for (const k of Object.keys(node.extraAttrs).sort()) {
      const v = node.extraAttrs[k];
      if (v != null && String(v).trim() !== '') parts.push(`${k}=${String(v).trim()}`);
    }
  }
  return parts.join('|');
}

export function hashOf(fingerprint: string, config: CoreConfig): string {
  return createHash(config.hashAlgorithm)
    .update(fingerprint)
    .digest('hex')
    .slice(0, Math.max(4, Math.min(16, config.hashLength)));
}
