/**
 * Angular adapter — AST-backed via @angular/compiler's parseTemplate (HANDOFF P2).
 *
 * Same shape as the Vue adapter: framework vocabulary maps into the closed RawSignals
 * contract; identity/fingerprint/diff policy stays in core. @angular/compiler is an
 * OPTIONAL peer dependency, lazily required. Opening-tag spans come from the AST
 * (startSourceSpan), so '>' inside attribute expressions can never corrupt writes.
 *
 * L2 symbol resolution reads the companion `<name>.ts` next to the template
 * (Angular's templateUrl convention) and slices class members / top-level
 * declarations with @babel/parser; absent companion or parser, it degrades to null.
 */
import { existsSync, readFileSync } from 'node:fs';
import { ElementNode, RawSignals } from '../core/types';
import { FrameworkAdapter, applyTestIdEdits, isOwnTestIdAttr, ownAttrRange } from './contract';
import { Edit } from '../server/service';

type NgNode = any;

function loadNgCompiler(): { parseTemplate: (src: string, url: string) => { nodes: NgNode[] } } {
  try {
    return require('@angular/compiler');
  } catch {
    throw new Error(
      'AngularAdapter requires the optional peer dependency "@angular/compiler". Install it: npm i -D @angular/compiler',
    );
  }
}

/** First identifier path in a binding expression: "!form.valid" -> "form.valid". */
function firstIdentifierPath(expr: string): string {
  const m = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(expr);
  return m ? m[0] : expr.trim();
}

/** Reduce a handler expression to its function name: "save($event)" -> "save". */
function handlerName(expr: string): string {
  const m = /^\s*([A-Za-z_$][\w$]*)\s*\(?/.exec(expr);
  return m ? m[1] : expr.trim();
}

export class AngularAdapter implements FrameworkAdapter {
  readonly name = 'angular';
  customTagMap: Record<string, { short: string; long: string }> = {};

  parse(source: string, file: string, component: string): ElementNode[] {
    const { nodes } = loadNgCompiler().parseTemplate(source, file);
    const out: ElementNode[] = [];

    const visit = (n: NgNode, inLoop: boolean) => {
      const ctor: string = n?.constructor?.name ?? '';
      let loop = inLoop;
      if (ctor.includes('Template')) {
        // *ngFor desugars to a Template wrapper carrying templateAttrs.
        if ((n.templateAttrs ?? []).some((a: any) => String(a.name).toLowerCase().startsWith('ngfor'))) loop = true;
      } else if (ctor.includes('ForLoopBlock')) {
        loop = true; // Angular 17+ @for block
      } else if (ctor.includes('Element')) {
        const tag: string = n.name;
        if (tag !== 'ng-container' && tag !== 'ng-template') {
          const attrs: Record<string, string> = {};
          for (const a of n.attributes ?? []) attrs[String(a.name).toLowerCase()] = a.value ?? '';
          const bound: Record<string, string> = {};
          const events: Record<string, string> = {};
          // Raw expression text goes to static_attributes (fingerprint-only): a pipe or
          // argument edit inside a binding must flag `modified` even though identity
          // only sees the normalized root/handler name.
          const exprs: Record<string, string> = {};
          for (const i of n.inputs ?? []) {
            const raw = i.value?.source ?? '';
            bound[String(i.name).toLowerCase()] = firstIdentifierPath(raw);
            exprs[`[${String(i.name).toLowerCase()}]`] = raw;
          }
          for (const o of n.outputs ?? []) {
            const raw = o.handler?.source ?? '';
            events[String(o.name).toLowerCase()] = handlerName(raw);
            exprs[`(${String(o.name).toLowerCase()})`] = raw;
          }

          // An author-bound [attr.data-testid] is the per-item loop fix: respect it.
          const hasBoundTestid = (n.inputs ?? []).some((i: any) =>
            ['data-testid', 'data-cy'].includes(String(i.name).toLowerCase()));

          if (!hasBoundTestid) {
            const text = (n.children ?? [])
              .filter((c: any) => (c?.constructor?.name ?? '').includes('Text') && !(c?.constructor?.name ?? '').includes('Bound'))
              .map((c: any) => String(c.value ?? ''))
              .join('')
              .trim();

            // Contract rule (parity-tested): named slot = static attr ?? bound root,
            // with the Angular [attr.<name>] form included. explicit_key is the one
            // exception — it must be an authored literal.
            const g = (k: string) => attrs[k] ?? bound[k] ?? bound[`attr.${k}`] ?? null;
            const signals: RawSignals = {
              explicit_key: attrs['data-tid'] ?? null,
              form_control: g('formcontrolname') ?? bound['ngmodel'] ?? g('name'),
              name: g('name'),
              route: g('routerlink') ?? g('href'),
              event_handlers: events,
              bound_identifiers: bound,
              html_id: g('id'),
              aria_label: g('aria-label'),
              placeholder: g('placeholder'),
              type: g('type'),
              role: g('role'),
            };
            // Static tabindex is a coverage-denominator input (isInteractive), not identity.
            if (attrs['tabindex'] != null) exprs['tabindex'] = attrs['tabindex'];
            if (Object.keys(exprs).length) signals.static_attributes = exprs;
            if (text) signals.text = text;

            out.push({
              component,
              tag,
              signals,
              existingId: attrs['data-testid'] ?? attrs['data-cy'] ?? null,
              loc: {
                file, start: n.sourceSpan.start.offset, end: n.startSourceSpan.end.offset - 1,
                strip: (n.attributes ?? [])
                  .filter((a: any) => isOwnTestIdAttr(String(a.name)) && a.sourceSpan)
                  .map((a: any) => ownAttrRange(source, a.sourceSpan.start.offset, a.sourceSpan.end.offset)),
              },
              inLoop: loop,
            });
          }
        }
      }
      const kids: NgNode[] = [
        ...(n.children ?? []),
        ...((n.branches ?? []).flatMap((b: any) => b.children ?? [])), // @if/@switch branches
      ];
      for (const c of kids) visit(c, loop);
    };
    for (const n of nodes) visit(n, false);
    return out;
  }

  write(source: string, edits: Edit[]): string {
    return applyTestIdEdits(source, edits);
  }

  /** Layer-2 host script: the companion `<name>.ts` (templateUrl convention). */
  scriptContext(_source: string, file: string) {
    const companion = file.replace(/\.html?$/i, '.ts');
    if (companion === file || !existsSync(companion)) return null;
    try {
      return { code: readFileSync(companion, 'utf8'), path: companion };
    } catch {
      return null;
    }
  }

  /** L2 resolver over the companion `<name>.ts` (templateUrl convention). */
  resolveSymbolDefs(names: string[], _source: string, file: string): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    for (const n of names) result[n] = null;
    const companion = file.replace(/\.html?$/i, '.ts');
    if (companion === file || !existsSync(companion)) return result;
    let ast: any[];
    let content: string;
    try {
      content = readFileSync(companion, 'utf8');
      const bp = require('@babel/parser') as { parse: (s: string, o?: any) => any };
      ast = bp.parse(content, { sourceType: 'module', plugins: ['typescript', 'decorators-legacy'] }).program?.body ?? [];
    } catch {
      return result; // unreadable/unparsable companion: resolve nothing rather than wrong
    }
    const slice = (node: any) => content.slice(node.start, node.end);
    const handleDecl = (node: any) => {
      const decl =
        (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') && node.declaration
          ? node.declaration
          : node;
      if (decl.type === 'FunctionDeclaration' && decl.id && names.includes(decl.id.name)) {
        result[decl.id.name] = slice(node);
      } else if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (d.id?.type === 'Identifier' && names.includes(d.id.name)) result[d.id.name] = slice(node);
        }
      } else if (decl.type === 'ImportDeclaration') {
        for (const s of decl.specifiers ?? []) {
          if (names.includes(s.local?.name)) result[s.local.name] = slice(node);
        }
      } else if (decl.type === 'ClassDeclaration') {
        for (const m of decl.body?.body ?? []) {
          const key = m.key;
          if (key?.type === 'Identifier' && names.includes(key.name)) result[key.name] = slice(m);
        }
      }
    };
    for (const node of ast) handleDecl(node);
    return result;
  }
}
