/**
 * Semantic key selection — pure policy, framework-neutral.
 *
 * The id's {key} token is the single most human-meaningful piece of an element's
 * identity. selectKey walks the configured priority chain (the FIRST non-empty
 * canonical hint wins) and falls back to the tag name when an element carries no
 * usable semantics. slugify turns the chosen raw value into an id-safe token.
 *
 * This is "policy", so it lives in core and is shared by every adapter. The
 * adapter only supplies the canonical hints; it never decides which one becomes
 * the key.
 */
import { ElementNode, CoreConfig } from './types';

/** Lowercase, collapse non-alphanumerics to single dashes, trim leading/trailing dashes. */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The raw winning value from the priority chain (or the tag name as a last resort). */
export function selectKey(node: ElementNode, config: CoreConfig): string {
  for (const field of config.keyPriority) {
    const v = node.semantic[field];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return node.tag;
}

/** The id-safe key token: the selected value, slugified. */
export function keyFor(node: ElementNode, config: CoreConfig): string {
  const raw = selectKey(node, config);
  const slug = slugify(raw);
  return slug || slugify(node.tag) || 'el';
}
