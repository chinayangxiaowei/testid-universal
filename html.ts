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
import { ElementNode, SemanticHints } from '../core/types';
import { FrameworkAdapter } from './contract';
import { Edit } from '../server/service';

const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);

/** Map raw HTML/Angular/Vue attributes onto canonical semantic hints. */
function normalize(tag: string, attrs: Record<string, string>): Partial<SemanticHints> {
  const get = (...names: string[]) => { for (const n of names) if (attrs[n] != null) return attrs[n]; return null; };
  return {
    field_name: get('formcontrolname', 'name', 'v-model', '[(ngmodel)]'),
    name: get('name'),
    aria_label: get('aria-label', 'arialabel'),
    placeholder: get('placeholder'),
    route: get('routerlink', 'to', 'href'),
    role: get('role'),
    type: get('type'),
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
    while ((m = tagRe.exec(source)) !== null) {
      const tag = m[1];
      if (tag === 'template' || tag === 'ng-container' || tag === 'ng-template') continue;
      const attrBlob = m[2] ?? '';
      const attrs = parseAttrs(attrBlob);

      // Capture direct text content for non-void tags (used as text_content hint).
      let text: string | null = null;
      if (!VOID_TAGS.has(tag.toLowerCase())) {
        const close = source.indexOf(`</${tag}`, tagRe.lastIndex);
        if (close !== -1) {
          const inner = source.slice(tagRe.lastIndex, close);
          if (!/[<]/.test(inner)) { const t = inner.trim(); if (t) text = t; }
        }
      }

      const semantic = normalize(tag, attrs);
      if (text) semantic.text_content = text;

      // end offset = index of the closing '>' so write() can rewrite the whole opening tag.
      const tagEnd = m.index + m[0].length - 1;
      nodes.push({
        component, tag, semantic,
        existingId: attrs['data-testid'] ?? attrs['data-cy'] ?? null,
        loc: { file, start: m.index, end: tagEnd },
      });
    }
    return nodes;
  }

  write(source: string, edits: Edit[]): string {
    // Idempotent: for each tagged element, rewrite its opening tag — strip any
    // existing data-testid/data-cy first, then add the assigned one. Re-running on
    // an already-tagged file produces identical output (no duplicate attributes).
    const ordered = [...edits].sort((a, b) => b.loc.start - a.loc.start);
    let out = source;
    for (const e of ordered) {
      const openTag = out.slice(e.loc.start, e.loc.end + 1);
      const selfClose = /\/>\s*$/.test(openTag);
      const inner = openTag
        .replace(/\/?>\s*$/, '')                                   // drop the closing '>' or '/>'
        .replace(/\s+(data-testid|data-cy)\s*=\s*"[^"]*"/g, '')     // drop existing test ids
        .replace(/\s+$/, '');
      const rebuilt = `${inner} ${e.attributeName}="${e.id}"${selfClose ? ' />' : '>'}`;
      out = out.slice(0, e.loc.start) + rebuilt + out.slice(e.loc.end + 1);
    }
    return out;
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
