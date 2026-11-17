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
  /**
   * OPTIONAL L2 capability (dual-map spec §3.3): resolve template-referenced symbol
   * names to their definition SOURCE TEXT in this file's script. Return null for a
   * name that cannot be resolved (template-local, options API, etc.). Core — never
   * the adapter — normalizes and hashes the text. Adapters without this capability
   * simply produce no symbol_defs (name-only tracking, the pre-Phase-D behavior).
   */
  resolveSymbolDefs?(names: string[], source: string, file: string): Record<string, string | null>;
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
 * rewrites the whole opening tag: it strips the tag's OWN pre-existing
 * data-testid/data-cy and appends the assigned attribute, preserving self-closing
 * form. Re-running on already-tagged source therefore produces identical output.
 *
 * Spans may NEST (React: `<Chat terminal={<Terminal />} />` — the inner opening tag
 * lives inside an outer attribute value). Edits are therefore arranged into a
 * containment tree and every tag is rebuilt from the ORIGINAL source, with nested
 * edits rendered recursively into their holes — no offset is ever reused after a
 * write. Partially overlapping spans are a contract violation and throw (fail
 * closed rather than corrupt source).
 *
 * Shared by the HTML, Vue, Angular and React adapters; any framework whose adapter
 * records opening-tag offsets can reuse it instead of reimplementing the surgery.
 */
export function applyTestIdEdits(source: string, edits: Edit[]): string {
  interface Node { e: Edit; children: Node[] }
  const sorted = [...edits].sort((a, b) => a.loc.start - b.loc.start || b.loc.end - a.loc.end);
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const e of sorted) {
    while (stack.length && stack[stack.length - 1].e.loc.end < e.loc.start) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent && e.loc.end > parent.e.loc.end) {
      throw new Error(
        `applyTestIdEdits: overlapping edit spans [${parent.e.loc.start},${parent.e.loc.end}] and [${e.loc.start},${e.loc.end}]`,
      );
    }
    const node: Node = { e, children: [] };
    (parent ? parent.children : roots).push(node);
    stack.push(node);
  }

  const render = ({ e, children }: Node): string => {
    // Walk the original tag text; own segments get top-level id stripping, nested
    // edits are rendered recursively in place.
    // The scanner state (brace depth, quote) carries across holes.
    const strip = ownTestIdStripper();
    let body = '';
    let cursor = e.loc.start;
    for (const c of children) {
      body += strip(source.slice(cursor, c.e.loc.start)) + render(c);
      cursor = c.e.loc.end + 1;
    }
    let tail = source.slice(cursor, e.loc.end + 1);
    const selfClose = /\/>\s*$/.test(tail);
    tail = strip(tail.replace(/\/?>\s*$/, '')).replace(/\s+$/, '');
    return `${body}${tail} ${e.attributeName}="${e.id}"${selfClose ? ' />' : '>'}`;
  };

  let out = '';
  let cursor = 0;
  for (const r of roots) {
    out += source.slice(cursor, r.e.loc.start) + render(r);
    cursor = r.e.loc.end + 1;
  }
  return out + source.slice(cursor);
}

/**
 * Returns a stateful stripper that removes ` data-testid="…"` / ` data-cy="…"` only
 * at a tag's own attribute level: occurrences inside a quoted value or a `{…}`
 * expression (where a nested JSX element may carry its own id) are left alone.
 * Feed it a tag's segments in order — brace/quote state carries across the holes
 * left by nested edits.
 */
function ownTestIdStripper(): (text: string) => string {
  const attr = /\s+(?:data-testid|data-cy)\s*=\s*"[^"]*"/y;
  let depth = 0;
  let quote: string | null = null;
  return (text) => {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        // Inside an expression, a quote glued to a word char is prose in nested JSX
        // text (`it's`), not a string literal opener.
        if (!(depth > 0 && /\w/.test(text[i - 1] ?? ''))) quote = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0 && /\s/.test(ch)) {
        attr.lastIndex = i;
        const m = attr.exec(text);
        if (m) {
          i += m[0].length - 1;
          continue;
        }
      }
      out += ch;
    }
    return out;
  };
}
