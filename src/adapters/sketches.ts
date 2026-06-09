// @ts-nocheck
/**
 * SKETCHES — how the remaining adapters would produce the SAME RawSignals.
 * Illustrative only (parsers not wired here). The framework-specific work is
 * confined to parse()/write() + mapping vocabulary into the closed RawSignals
 * contract; the engine, registry, diff, locators and backend are untouched.
 */
import { ElementNode, RawSignals } from '../core/types';

/* Angular: @angular/compiler parseTemplate -> walk the template AST. */
export function angularParseSketch(source: string, file: string, component: string): ElementNode[] {
  const ast: any[] = []; // = walk(parseTemplate(source, file).nodes)
  return ast.map((el) => ({
    component, tag: el.name,
    signals: {
      form_control: attr(el, 'formControlName') ?? bound(el, 'ngModel'),
      name: attr(el, 'name'),
      aria_label: attr(el, 'aria-label'),
      placeholder: attr(el, 'placeholder'),
      route: attr(el, 'routerLink'),
      type: attr(el, 'type'),
      event_handlers: events(el),
      text: directText(el),
    } as RawSignals,
    loc: { file, start: el.sourceSpan.start.offset, end: el.startSourceSpan.end.offset - 1 },
    existingId: attr(el, 'data-testid'),
  }));
}

/* React: @babel/parser + traverse JSXOpeningElement. One source node can render
 * N times; the fingerprint is built from props only and the id is shared by all
 * runtime instances (the documented React caveat). */
export function reactParseSketch(source: string, file: string, component: string): ElementNode[] {
  const jsxElements: any[] = [];
  return jsxElements.map((node) => ({
    component, tag: node.tagName,
    signals: {
      form_control: jsxProp(node, 'name'),
      name: jsxProp(node, 'name'),
      aria_label: jsxProp(node, 'aria-label'),
      placeholder: jsxProp(node, 'placeholder'),
      route: jsxProp(node, 'to') ?? jsxProp(node, 'href'),
      type: jsxProp(node, 'type'),
      event_handlers: jsxEvents(node),
      text: jsxText(node),
    } as RawSignals,
    loc: { file, start: node.start, end: node.name.end },
    existingId: jsxProp(node, 'data-testid'),
  }));
}

// --- pseudo helpers (would be implemented against each real AST) ---
const attr = (_e: any, _n: string): string | null => null;
const bound = (_e: any, _n: string): string | null => null;
const events = (_e: any): Record<string, string> => ({});
const jsxProp = (_e: any, _n: string): string | null => null;
const jsxEvents = (_e: any): Record<string, string> => ({});
const directText = (_e: any): string | null => null;
const jsxText = (_e: any): string | null => null;
