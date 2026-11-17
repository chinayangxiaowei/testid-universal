/**
 * Reference adapter: minimal HTML-template parser (dependency-free).
 *
 * This is a REAL, working adapter for HTML-like templates (plain HTML, and good
 * enough for Angular/Vue `<template>` for demonstration). It shows that once you
 * can produce ElementNode[], the entire backend pipeline just works.
 *
 * It is intentionally small (a tag scanner, not a spec-compliant parser). A
 * production Angular/Vue/React adapter would use @angular/compiler /
 * @vue/compiler-sfc / @babel/parser to build the SAME ElementNode[] — see the
 * *.sketch.ts files. The normalization map below is the "vocabulary" seam.
 */
import { ElementNode, RawSignals, Edit } from '../core/types';
import { FrameworkAdapter, applyTestIdEdits } from './contract';

const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);

/** Map raw HTML/Angular/Vue attributes onto the closed RawSignals contract. */
function normalize(attrs: Record<string, string>): RawSignals {
  const get = (...names: string[]) => { for (const n of names) if (attrs[n] != null) return attrs[n]; return null; };
  return {
    explicit_key: get('data-tid'),
    form_control: get('formcontrolname', 'name'),
    name: get('name'),
    route: get('routerlink', 'to', 'href'),
    html_id: get('id'),
    aria_label: get('aria-label'),
    placeholder: get('placeholder'),
    type: get('type'),
    role: get('role'),
  };
}

export class HtmlTemplateAdapter implements FrameworkAdapter {
  readonly name = 'html';
  customTagMap: Record<string, { short: string; long: string }> = {};

  parse(source: string, file: string, component: string): ElementNode[] {
    const nodes: ElementNode[] = [];
    // Source ranges spanned by *ngFor subtrees (naive closing-tag scan, consistent
    // with this adapter's text extraction): elements starting inside one are inLoop.
    const loopRanges: { start: number; end: number }[] = [];
    for (const m of scanOpenTags(source)) {
      const tag = m.tag;
      // Structural/non-content tags are never test targets; their text is code or
      // metadata, not UI copy (a real served page surfaced <script>/<title> noise).
      if (['template', 'ng-container', 'ng-template', 'script', 'style', 'title', 'head'].includes(tag.toLowerCase())) continue;
      const attrBlob = m.attrBlob;
      const after = m.end + 1;
      const attrs = parseAttrs(attrBlob);

      const hasNgFor = attrBlob.includes('*ngFor') || attrBlob.includes('*ngfor');
      if (hasNgFor && !VOID_TAGS.has(tag.toLowerCase())) {
        const close = source.indexOf(`</${tag}`, after);
        loopRanges.push({ start: m.start, end: close === -1 ? source.length : close });
      }
      const inLoop = hasNgFor || loopRanges.some((r) => m.start > r.start && m.start < r.end);

      // Capture direct text content for non-void tags (used as text_content hint).
      let text: string | null = null;
      if (!VOID_TAGS.has(tag.toLowerCase())) {
        const close = source.indexOf(`</${tag}`, after);
        if (close !== -1) {
          const inner = source.slice(after, close);
          if (!/[<]/.test(inner)) { const t = inner.trim(); if (t) text = t; }
        }
      }

      const signals = normalize(attrs);
      if (text) signals.text = text;

      nodes.push({
        component, tag, signals,
        existingId: attrs['data-testid'] ?? attrs['data-cy'] ?? null,
        loc: { file, start: m.start, end: m.end },
        inLoop,
      });
    }
    return nodes;
  }

  write(source: string, edits: Edit[]): string {
    // Idempotent opening-tag rewrite, shared with the Vue adapter.
    return applyTestIdEdits(source, edits);
  }
}

/** Elements whose body is raw text (never markup) — skipped wholesale by the scanner. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

interface OpenTag { tag: string; attrBlob: string; start: number; end: number }

/**
 * Quote-aware opening-tag scanner (still not a spec parser). A tag ends at the
 * first '>' OUTSIDE a quoted attribute value, so `title="a > b"` and
 * `[x]="n > 3"` stay inside the tag; '<' inside a quoted value is not a tag;
 * `<!-- … -->` comments and raw-text bodies (script/style/textarea/title) are
 * skipped. `end` is the offset of the tag's closing '>' (the write-back contract).
 */
function* scanOpenTags(source: string): Generator<OpenTag> {
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) return;
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      if (close === -1) return;
      i = close + 3;
      continue;
    }
    const name = /^<([a-zA-Z][\w-]*)(?=[\s/>])/.exec(source.slice(lt, lt + 256));
    if (!name) { i = lt + 1; continue; }
    let j = lt + name[0].length;
    let quote: string | null = null;
    let end = -1;
    for (; j < source.length; j++) {
      const ch = source[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') { end = j; break; }
      else if (ch === '<') break; // unquoted '<' — not a well-formed tag
    }
    if (end === -1) { i = lt + 1; continue; }
    const tag = name[1];
    yield { tag, attrBlob: source.slice(lt + name[0].length, end).replace(/\s*\/?\s*$/, ''), start: lt, end };
    i = end + 1;
    if (RAW_TEXT_TAGS.has(tag.toLowerCase())) {
      const close = source.toLowerCase().indexOf(`</${tag.toLowerCase()}`, i);
      i = close === -1 ? source.length : close;
    }
  }
}

function parseAttrs(blob: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:@\[\]()\w-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob)) !== null) {
    const rawName = m[1].toLowerCase().replace(/^[\[(]+|[\])]+$/g, ''); // strip Angular [()] binding brackets
    attrs[rawName] = m[2] ?? m[3] ?? '';
  }
  return attrs;
}
