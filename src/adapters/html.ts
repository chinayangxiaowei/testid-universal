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
import { ElementNode, RawSignals } from '../core/types';
import { FrameworkAdapter, applyTestIdEdits } from './contract';
import { Edit } from '../server/service';

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
    // Match an opening tag and capture: tag name, attribute blob, end offset of the tag.
    const tagRe = /<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*\/?>/g;
    let m: RegExpExecArray | null;
    // Source ranges spanned by *ngFor subtrees (naive closing-tag scan, consistent
    // with this adapter's text extraction): elements starting inside one are inLoop.
    const loopRanges: { start: number; end: number }[] = [];
    while ((m = tagRe.exec(source)) !== null) {
      const tag = m[1];
      // Structural/non-content tags are never test targets; their text is code or
      // metadata, not UI copy (a real served page surfaced <script>/<title> noise).
      if (['template', 'ng-container', 'ng-template', 'script', 'style', 'title', 'head'].includes(tag.toLowerCase())) continue;
      const attrBlob = m[2] ?? '';
      const attrs = parseAttrs(attrBlob);

      const hasNgFor = attrBlob.includes('*ngFor') || attrBlob.includes('*ngfor');
      if (hasNgFor && !VOID_TAGS.has(tag.toLowerCase())) {
        const close = source.indexOf(`</${tag}`, tagRe.lastIndex);
        loopRanges.push({ start: m.index, end: close === -1 ? source.length : close });
      }
      const inLoop = hasNgFor || loopRanges.some((r) => m!.index > r.start && m!.index < r.end);

      // Capture direct text content for non-void tags (used as text_content hint).
      let text: string | null = null;
      if (!VOID_TAGS.has(tag.toLowerCase())) {
        const close = source.indexOf(`</${tag}`, tagRe.lastIndex);
        if (close !== -1) {
          const inner = source.slice(tagRe.lastIndex, close);
          if (!/[<]/.test(inner)) { const t = inner.trim(); if (t) text = t; }
        }
      }

      const signals = normalize(attrs);
      if (text) signals.text = text;

      const tagEnd = m.index + m[0].length - 1;
      nodes.push({
        component, tag, signals,
        existingId: attrs['data-testid'] ?? attrs['data-cy'] ?? null,
        loc: { file, start: m.index, end: tagEnd },
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
