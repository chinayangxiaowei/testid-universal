/**
 * Adapter contract — the ONLY framework-specific seam.
 *
 * An adapter does exactly two framework-aware things:
 *   1. parse():  source text  ->  ElementNode[]   (normalize vocab into canonical hints)
 *   2. write():  source text + edits -> new source (inject the attribute)
 *
 * Everything downstream (ids, registry, diff, locators, backend) is shared. To
 * support a new framework you implement this interface and nothing else.
 */
import { ElementNode } from '../core/types';
import { Edit } from '../server/service';

export interface FrameworkAdapter {
  readonly name: string;
  /** Parse one source file into the canonical IR. */
  parse(source: string, file: string, component: string): ElementNode[];
  /** Apply backend-assigned edits to the source and return the rewritten text. */
  write(source: string, edits: Edit[]): string;
  /** Per-framework defaults, e.g. its customTagMap for the local component library. */
  customTagMap?: Record<string, { short: string; long: string }>;
}

/**
 * Generic write-back: edits carry character offsets, so attribute injection is the
 * same string surgery regardless of framework. We insert ` attr="id"` right after
 * the tag name. (Real adapters with an AST can re-print instead; this offset-based
 * version works for HTML-like templates.)
 */
export function applyEditsByOffset(source: string, edits: Edit[]): string {
  // Apply right-to-left so earlier offsets stay valid.
  const ordered = [...edits].sort((a, b) => b.loc.start - a.loc.start);
  let out = source;
  for (const e of ordered) {
    const insertion = ` ${e.attributeName}="${e.id}"`;
    out = out.slice(0, e.loc.end) + insertion + out.slice(e.loc.end);
  }
  return out;
}

/**
 * Idempotent attribute write-back for tag-offset adapters.
 *
 * Each edit's `loc` must span an element's opening tag — `loc.start` at the `<`
 * and `loc.end` at the closing `>` (or the `>` of `/>`). For every edit this
 * rewrites the whole opening tag: it strips any pre-existing data-testid/data-cy
 * and appends the assigned attribute, preserving self-closing form. Re-running on
 * already-tagged source therefore produces identical output (no duplicates).
 *
 * Shared by the HTML and Vue adapters; any framework whose adapter records opening-
 * tag offsets can reuse it instead of reimplementing the surgery.
 */
export function applyTestIdEdits(source: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.loc.start - a.loc.start);
  let out = source;
  for (const e of ordered) {
    const openTag = out.slice(e.loc.start, e.loc.end + 1);
    const selfClose = /\/>\s*$/.test(openTag);
    const inner = openTag
      .replace(/\/?>\s*$/, '')                                 // drop the closing '>' or '/>'
      .replace(/\s+(data-testid|data-cy)\s*=\s*"[^"]*"/g, '')   // drop existing test ids
      .replace(/\s+$/, '');
    const rebuilt = `${inner} ${e.attributeName}="${e.id}"${selfClose ? ' />' : '>'}`;
    out = out.slice(0, e.loc.start) + rebuilt + out.slice(e.loc.end + 1);
  }
  return out;
}
