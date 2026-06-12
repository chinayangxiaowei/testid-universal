/**
 * React adapter — AST-backed via @babel/parser (jsx + typescript plugins).
 *
 * Same shape as the Vue/Angular adapters: JSX vocabulary maps into the closed
 * RawSignals contract; identity/fingerprint/diff policy stays in core. Opening-tag
 * spans come from the AST, so '>' inside expressions can never corrupt writes.
 *
 * React caveat (documented, not fought): JSX has no static DOM — one source node
 * renders N runtime instances. Identity is built from the element's own props only
 * and every instance shares one id; `.map()` ancestry sets `inLoop` so the engine
 * emits the loop-multiplicity warning (bind a per-item `data-testid={...}` instead,
 * which this adapter respects and skips).
 *
 * L2 symbol resolution works on the SAME file: handlers live next to the JSX, so
 * `resolveSymbolDefs` slices named declarations (top-level and component-body)
 * straight from the parsed source; imports stay the L3 opaque boundary.
 */
import { ElementNode, RawSignals } from '../core/types';
import { FrameworkAdapter, applyTestIdEdits } from './contract';
import { Edit } from '../server/service';

type BabelNode = any;

function loadParser(): { parse: (s: string, o?: any) => any } {
  return require('@babel/parser');
}

const PARSE_OPTS = {
  sourceType: 'module' as const,
  plugins: ['jsx', 'typescript', 'decorators-legacy'],
  errorRecovery: true,
};

/** First identifier path in an expression: "!form.valid" -> "form.valid". */
function firstIdentifierPath(expr: string): string {
  const m = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(expr);
  return m ? m[0] : expr.trim();
}

/**
 * Resolve a JSX handler expression to the function it ultimately calls:
 * `submit` -> submit; `props.onDone` -> onDone; `() => pick(it)` -> pick;
 * `(e) => setEmail(e.target.value)` -> setEmail. Arrows need the AST — a regex
 * would capture the parameter name.
 */
function handlerFromExpr(node: BabelNode): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'Identifier':
      return node.name;
    case 'MemberExpression':
      return node.property?.type === 'Identifier' ? node.property.name : null;
    case 'CallExpression':
      return handlerFromExpr(node.callee);
    case 'ArrowFunctionExpression':
    case 'FunctionExpression': {
      const call = findFirstCall(node.body);
      return call ? handlerFromExpr(call.callee) : null;
    }
    default:
      return null;
  }
}

function findFirstCall(node: BabelNode): BabelNode | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = findFirstCall(c);
      if (hit) return hit;
    }
    return null;
  }
  if (node.type === 'CallExpression') return node;
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    const hit = findFirstCall(node[k]);
    if (hit) return hit;
  }
  return null;
}

function jsxTagName(name: BabelNode): string {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return `${jsxTagName(name.object)}.${name.property.name}`;
  return String(name.name ?? '');
}

export class ReactAdapter implements FrameworkAdapter {
  readonly name = 'react';
  customTagMap: Record<string, { short: string; long: string }>;

  constructor(customTagMap: Record<string, { short: string; long: string }> = {}) {
    this.customTagMap = customTagMap;
  }

  parse(source: string, file: string, component: string): ElementNode[] {
    const ast = loadParser().parse(source, PARSE_OPTS);
    const out: ElementNode[] = [];

    const visit = (n: BabelNode, inLoop: boolean) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const c of n) visit(c, inLoop);
        return;
      }
      let loop = inLoop;
      if (
        n.type === 'CallExpression' &&
        n.callee?.type === 'MemberExpression' &&
        n.callee.property?.type === 'Identifier' &&
        ['map', 'flatMap'].includes(n.callee.property.name)
      ) {
        loop = true; // the JSX analog of v-for / *ngFor
      }
      if (n.type === 'JSXElement') {
        this.collectElement(n, source, file, component, loop, out);
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc') continue;
        visit(n[k], loop);
      }
    };
    visit(ast.program, false);
    return out;
  }

  private collectElement(
    n: BabelNode,
    source: string,
    file: string,
    component: string,
    inLoop: boolean,
    out: ElementNode[],
  ): void {
    const open = n.openingElement;
    const tag = jsxTagName(open.name);

    const attrs: Record<string, string> = {};
    const bound: Record<string, string> = {};
    const events: Record<string, string> = {};
    const exprs: Record<string, string> = {};
    let boundTestid = false;

    for (const a of open.attributes ?? []) {
      if (a.type !== 'JSXAttribute' || a.name?.type !== 'JSXIdentifier') continue; // spreads stay out of identity
      const rawName: string = a.name.name;
      const name = rawName.toLowerCase();
      if (a.value == null || a.value.type === 'StringLiteral') {
        attrs[name] = a.value?.value ?? '';
        continue;
      }
      if (a.value.type !== 'JSXExpressionContainer') continue;
      const expr = a.value.expression;
      const raw = source.slice(expr.start, expr.end);
      if (name === 'data-testid' || name === 'data-cy') {
        boundTestid = true; // the per-item loop fix: respect it, never mint beside it
        continue;
      }
      if (/^on[A-Z]/.test(rawName)) {
        const h = handlerFromExpr(expr);
        if (h) events[name.slice(2)] = h;
        exprs[`{${name}}`] = raw;
        continue;
      }
      exprs[`{${name}}`] = raw;
      if (name === 'key' || name === 'ref') continue; // list bookkeeping, not wiring
      if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') continue;
      bound[name] = firstIdentifierPath(raw);
    }

    if (!boundTestid) {
      const text = (n.children ?? [])
        .filter((c: BabelNode) => c.type === 'JSXText')
        .map((c: BabelNode) => String(c.value ?? ''))
        .join('')
        .trim();

      const signals: RawSignals = {
        explicit_key: attrs['data-tid'] ?? null,
        form_control: attrs['name'] ?? null,
        name: attrs['name'] ?? null,
        route: attrs['to'] ?? bound['to'] ?? attrs['href'] ?? null,
        event_handlers: events,
        bound_identifiers: bound,
        html_id: attrs['id'] ?? null,
        aria_label: attrs['aria-label'] ?? null,
        placeholder: attrs['placeholder'] ?? null,
        type: attrs['type'] ?? null,
        role: attrs['role'] ?? null,
      };
      if (Object.keys(exprs).length) signals.static_attributes = exprs;
      if (text) signals.text = text;

      out.push({
        component,
        tag,
        signals,
        existingId: attrs['data-testid'] ?? attrs['data-cy'] ?? null,
        loc: { file, start: open.start, end: open.end - 1 },
        inLoop,
      });
    }
  }

  write(source: string, edits: Edit[]): string {
    return applyTestIdEdits(source, edits);
  }

  /** L2 resolver over the JSX file itself (handlers live next to the markup). */
  resolveSymbolDefs(names: string[], source: string, _file: string): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    for (const n of names) result[n] = null;
    if (!source) return result;
    let program: BabelNode;
    try {
      program = loadParser().parse(source, PARSE_OPTS).program;
    } catch {
      return result;
    }
    const wanted = new Set(names);
    const record = (name: string, node: BabelNode) => {
      if (wanted.has(name) && result[name] == null && node?.start != null) {
        result[name] = source.slice(node.start, node.end);
      }
    };
    const scan = (n: BabelNode) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const c of n) scan(c);
        return;
      }
      // Export wrappers are unwrapped so default-exported components stay visible
      // (the Angular export-default lesson).
      const decl =
        (n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration') && n.declaration
          ? n.declaration
          : n;
      if (decl.type === 'ImportDeclaration') {
        for (const s of decl.specifiers ?? []) {
          if (s.local?.name) record(s.local.name, decl);
        }
      } else if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
        record(decl.id.name, decl);
      } else if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations ?? []) {
          if (d.id?.type === 'Identifier') record(d.id.name, decl);
        }
      } else if (decl.type === 'ClassDeclaration') {
        if (decl.id?.name) record(decl.id.name, decl);
        for (const m of decl.body?.body ?? []) {
          if (m.key?.type === 'Identifier') record(m.key.name, m);
        }
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc') continue;
        scan(n[k]);
      }
    };
    scan(program);
    return result;
  }
}
