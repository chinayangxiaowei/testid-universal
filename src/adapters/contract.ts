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
import { ElementNode, Edit } from '../core/types';

/**
 * What an adapter's `scriptContext()` hands the shared layer-2 dependency resolver
 * (`src/client/deps.ts`): the script that holds the handlers, and where it lives.
 * Defined here — it is this seam's type — so the adapter layer never imports from
 * the client layer; the client imports it from the adapters instead.
 */
export interface ScriptContext {
  code: string;
  /** Path used to resolve relative imports (the SFC / JSX file, or Angular's companion .ts). */
  path: string;
}

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
  /**
   * OPTIONAL layer-2 capability: hand over the JS/TS script that holds this file's
   * handlers (and the path its relative imports resolve from). The shared resolver
   * (`src/client/deps.ts`) then follows ONE hop past each referenced symbol — the
   * helpers / imports / hooks / injected services its definition directly uses.
   * Return null when the file has no script.
   */
  scriptContext?(source: string, file: string): ScriptContext | null;
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
 * data-testid/data-cy and inserts the assigned attribute before the tag's closing
 * `>`/`/>`; every other byte (newlines, indentation, self-close spacing) is kept, so
 * removing the inserted attribute yields the original source. Re-running on
 * already-tagged source therefore produces identical output.
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
    // AST adapters name the exact own-attribute ranges (loc.strip); otherwise the
    // lexer runs, its state (brace depth, quote) carried across holes.
    const own = e.loc.strip ? [...e.loc.strip].sort((a, b) => a[0] - b[0]) : null;
    const lex = own ? null : ownTestIdStripper();
    const seg = (from: number, to: number): string => {
      if (!own) return lex!(source.slice(from, to));
      let s = '';
      let c = from;
      for (const [a, b] of own) {
        if (b <= from || a >= to) continue;
        s += source.slice(c, Math.max(a, from));
        c = Math.min(b, to);
      }
      return s + source.slice(c, to);
    };
    let body = '';
    let cursor = e.loc.start;
    for (const c of children) {
      body += seg(cursor, c.e.loc.start) + render(c);
      cursor = c.e.loc.end + 1;
    }
    // Minimal invasion: the attribute goes right before the tag's original closing
    // run (whitespace + `>` or `/>`), which is kept verbatim — newlines/indent and
    // the self-close form are the author's formatting, not ours to normalize.
    const tail = source.slice(cursor, e.loc.end + 1);
    const closing = /\s*\/?>\s*$/.exec(tail)?.[0] ?? '';
    const head = seg(cursor, e.loc.end + 1 - closing.length);
    return `${body}${head} ${e.attributeName}="${e.id}"${closing}`;
  };

  let out = '';
  let cursor = 0;
  for (const r of roots) {
    out += source.slice(cursor, r.e.loc.start) + render(r);
    cursor = r.e.loc.end + 1;
  }
  return out + source.slice(cursor);
}

/** An own-attribute strip range: the attribute plus the whitespace before it. */
export function ownAttrRange(source: string, start: number, end: number): [number, number] {
  let s = start;
  while (s > 0 && /\s/.test(source[s - 1])) s--;
  return [s, end];
}

const OWN_TESTID_ATTRS = new Set(['data-testid', 'data-cy']);
/** Whether an attribute name is one the writer replaces (the tag's own static testid). */
export function isOwnTestIdAttr(name: string): boolean {
  return OWN_TESTID_ATTRS.has(name.toLowerCase());
}

/**
 * Returns a stateful stripper that removes ` data-testid="…"` / ` data-cy="…"` only
 * at a tag's own attribute level: occurrences inside a quoted value or a `{…}`
 * expression (where a nested JSX element may carry its own id) are left alone.
 * Feed it a tag's segments in order — brace/quote state carries across the holes
 * left by nested edits.
 */
function ownTestIdStripper(): (text: string) => string {
  const attr = /\s+(?:data-testid|data-cy)\s*=\s*(?:"[^"]*"|'[^']*')/y;
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
