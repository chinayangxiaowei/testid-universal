// @ts-nocheck
/**
 * SKETCHES — how the three real adapters would produce the SAME ElementNode[].
 *
 * These are illustrative (parsers are not installed here). The point is to show
 * that the framework-specific work is confined to parse()/write() and the
 * vocabulary map — the engine, registry, diff, locators and backend are untouched.
 */
import { ElementNode, SemanticHints } from '../core/types';

/* ---------------------------------------------------------------- Angular ---
 * Use @angular/compiler's template parser. Angular templates are separate .html
 * files, so this is the cleanest case: walk the parsed AST, read attributes.
 */
export function angularParseSketch(source: string, file: string, component: string): ElementNode[] {
  // import { parseTemplate } from '@angular/compiler';
  // const { nodes } = parseTemplate(source, file);
  const ast: any[] = []; // = walk(parseTemplate(source, file).nodes)
  return ast.map((el) => ({
    component, tag: el.name,
    semantic: {
      field_name: attr(el, 'formControlName') ?? bound(el, 'ngModel'),
      aria_label: attr(el, 'aria-label'),
      placeholder: attr(el, 'placeholder'),
      route: attr(el, 'routerLink'),
      type: attr(el, 'type'),
      text_content: directText(el),
    } as Partial<SemanticHints>,
    loc: { file, start: el.sourceSpan.start.offset, end: el.startSourceSpan.end.offset - 1 },
    existingId: attr(el, 'data-testid'),
  }));
}

/* ------------------------------------------------------------------- Vue ---
 * IMPLEMENTED. The Vue sketch has graduated into a real adapter backed by
 * @vue/compiler-sfc — see `src/adapters/vue.ts` (VueAdapter + VUETIFY_TAG_MAP).
 * The remaining sketches stay illustrative until they are likewise built.
 */

/* ----------------------------------------------------------------- React ---
 * The hard case: source is JSX, not a DOM. Use @babel/parser + @babel/traverse,
 * visit JSXOpeningElement nodes. Loops/conditionals mean one source node can
 * render N times — so the fingerprint is built from props only, and the id is
 * shared by all runtime instances (the documented React caveat).
 */
export function reactParseSketch(source: string, file: string, component: string): ElementNode[] {
  // import { parse } from '@babel/parser';
  // import traverse from '@babel/traverse';
  const jsxElements: any[] = [];
  return jsxElements.map((node) => ({
    component, tag: node.tagName, // host element or component name
    semantic: {
      field_name: jsxProp(node, 'name'),
      aria_label: jsxProp(node, 'aria-label'),
      placeholder: jsxProp(node, 'placeholder'),
      route: jsxProp(node, 'to') ?? jsxProp(node, 'href'),
      type: jsxProp(node, 'type'),
      text_content: jsxText(node),
    } as Partial<SemanticHints>,
    loc: { file, start: node.start, end: node.name.end }, // inject after the tag name
    existingId: jsxProp(node, 'data-testid'),
  }));
}

// --- pseudo helpers (would be implemented against each real AST) ---
const attr = (_e: any, _n: string): string | null => null;
const bound = (_e: any, _n: string): string | null => null;
const prop = (_e: any, _n: string): string | null => null;
const jsxProp = (_e: any, _n: string): string | null => null;
const directText = (_e: any): string | null => null;
const jsxText = (_e: any): string | null => null;
