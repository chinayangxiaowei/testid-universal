/**
 * Layer-2 source-dependency resolution (dep_defs) — framework-agnostic JS/TS.
 *
 * Layer 1 (`symbol_defs`) hashes the definition of each symbol a template element
 * references directly (its handler / bound identifier). This module adds exactly ONE
 * more hop: the definitions that handler body DIRECTLY uses —
 *
 *   - a same-file helper / same-class method          submit → validate
 *   - an imported function (named / default / ns)    submit → createOrder | api.createOrder
 *   - a hook a destructured handler comes from       save   → useOrders
 *   - an Angular injected service method             submit → svc.create
 *   - a template-referenced import itself            createOrder → createOrder
 *
 * Imports resolve through relative paths and tsconfig/jsconfig `paths` aliases, and
 * re-export chains (`export * from`, `export { x as y } from`, barrels) are followed
 * to the real declaration — a re-export is plumbing, not a layer. Only the referenced
 * declaration is sliced (never the whole module), so a sibling export's edit does not
 * flag. The third hop (what createOrder itself calls) is NOT followed, nor are bare
 * packages (node_modules) or dynamic dispatch. A local-looking import that cannot be
 * resolved is reported in `unresolved` — never silently treated as unchanged.
 *
 * This lives in the client layer (it reads files); core only hashes the returned text.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** What an adapter hands over: the script that holds the handlers, and where it lives. */
export interface ScriptContext {
  code: string;
  /** Path used to resolve relative imports (the SFC / JSX file, or Angular's companion .ts). */
  path: string;
}

export interface DepResolution {
  /** referenced symbol name -> { "<name>><ref>": raw definition text } */
  byName: Record<string, Record<string, string>>;
  /** "<specifier>#<export>" for local-looking imports that could not be resolved. */
  unresolved: string[];
}

type Node = any;
type ImportBinding = { source: string; imported: string }; // imported: name | 'default' | '*'

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const MAX_REEXPORT_HOPS = 8;
/** Bare specifiers that are local aliases by convention even without a tsconfig. */
const LOCAL_ALIAS_PREFIX = /^(@\/|~\/|~|#)/;

let parser: { parse: (s: string, o?: object) => Node } | null | undefined;
function loadParser() {
  if (parser === undefined) {
    try {
      parser = require('@babel/parser');
    } catch {
      parser = null;
    }
  }
  return parser;
}

function parseModule(code: string, path: string): Node | null {
  const p = loadParser();
  if (!p) return null;
  const isPlainTs = /\.(m|c)?ts$/i.test(path);
  const attempts = isPlainTs
    ? [['typescript', 'decorators-legacy'], ['typescript', 'jsx', 'decorators-legacy']]
    : [['typescript', 'jsx', 'decorators-legacy'], ['typescript', 'decorators-legacy']];
  for (const plugins of attempts) {
    try {
      return p.parse(code, { sourceType: 'module', plugins, errorRecovery: true }).program;
    } catch {
      /* try the next plugin set */
    }
  }
  return null;
}

/** Depth-first walk with parent links; `visit` returning false skips the subtree. */
function walk(node: Node, visit: (n: Node, parent: Node | null, key: string) => boolean | void, parent: Node | null = null, key = '') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit, parent, key);
    return;
  }
  if (typeof node.type !== 'string') return;
  if (visit(node, parent, key) === false) return;
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    walk(node[k], visit, node, k);
  }
}

function patternNames(p: Node, out: string[] = []): string[] {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') for (const prop of p.properties) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
  else if (p.type === 'ArrayPattern') for (const el of p.elements) patternNames(el?.type === 'RestElement' ? el.argument : el, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'TSParameterProperty') patternNames(p.parameter, out);
  return out;
}

/** Per-file analysis of the host script: bindings visible to the handlers. */
interface HostIndex {
  code: string;
  imports: Map<string, ImportBinding>;
  /** name -> { node to slice, node whose range bounds the definition } (first wins). */
  decls: Map<string, { slice: Node; def: Node; method?: boolean }>;
  /** Angular DI: class property name -> injected class name. */
  injected: Map<string, string>;
}

function indexHost(program: Node, code: string): HostIndex {
  const imports = new Map<string, ImportBinding>();
  const decls = new Map<string, { slice: Node; def: Node; method?: boolean }>();
  const injected = new Map<string, string>();
  const add = (name: string, v: { slice: Node; def: Node; method?: boolean }) => { if (!decls.has(name)) decls.set(name, v); };
  for (const stmt of program.body) {
    if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type') continue;
    for (const s of stmt.specifiers ?? []) {
      const imported =
        s.type === 'ImportDefaultSpecifier' ? 'default'
          : s.type === 'ImportNamespaceSpecifier' ? '*'
            : (s.imported?.name ?? s.imported?.value);
      imports.set(s.local.name, { source: stmt.source.value, imported });
    }
  }
  walk(program, (n, parent) => {
    if (n.type === 'FunctionDeclaration' && n.id) {
      add(n.id.name, { slice: parent?.type?.startsWith('Export') ? parent : n, def: n });
    } else if (n.type === 'VariableDeclarator') {
      // Slice the whole statement (matches the layer-1 resolvers); bound by the declarator.
      const stmt = parent?.type === 'VariableDeclaration' ? parent : n;
      for (const name of patternNames(n.id)) add(name, { slice: stmt, def: n });
    } else if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
      if (n.id) add(n.id.name, { slice: n, def: n });
      for (const m of n.body?.body ?? []) {
        const key = m.key?.name;
        if (m.type === 'ClassMethod' && m.kind === 'constructor') {
          for (const p of m.params ?? []) {
            if (p.type !== 'TSParameterProperty') continue;
            const t = p.parameter?.typeAnnotation?.typeAnnotation;
            if (p.parameter?.type === 'Identifier' && t?.type === 'TSTypeReference' && t.typeName?.type === 'Identifier') {
              injected.set(p.parameter.name, t.typeName.name);
            }
          }
          continue;
        }
        if (!key) continue;
        const isFn = m.type === 'ClassMethod' || /Function/.test(m.value?.type ?? '');
        add(key, { slice: m, def: m, method: isFn });
        const v = m.value;
        if (m.type === 'ClassProperty' && v?.type === 'CallExpression' && v.callee?.name === 'inject' && v.arguments?.[0]?.type === 'Identifier') {
          injected.set(key, v.arguments[0].name);
        }
      }
    }
  });
  return { code, imports, decls, injected };
}

/** References a definition makes, as `name` / `ns.member` / `prop.member` (Angular DI). */
interface Ref { key: string; kind: 'import' | 'ns' | 'local' | 'service' | 'alias'; name: string; member?: string }

/** `const x = importedFactory(...)` — returns the factory's import binding name. */
function factoryOf(def: Node, host: HostIndex): string | null {
  if (def?.type !== 'VariableDeclarator' || def.id?.type !== 'Identifier') return null;
  const init = def.init?.type === 'AwaitExpression' ? def.init.argument : def.init;
  const callee = init?.type === 'CallExpression' && init.callee?.type === 'Identifier' ? init.callee.name : null;
  const imp = callee ? host.imports.get(callee) : undefined;
  return imp && imp.imported !== '*' ? callee : null;
}

function collectRefs(def: Node, self: string, host: HostIndex): Ref[] {
  const refs = new Map<string, Ref>();
  const own = new Set(def.type === 'VariableDeclarator' ? patternNames(def.id) : [self]);
  const within = (n: Node) => n.start >= def.start && n.end <= def.end;
  walk(def, (n, parent, key) => {
    // this.<prop>.<member>  (Angular injected service)   /   this.<method>  (same class)
    if (n.type === 'MemberExpression' && !n.computed && n.object?.type === 'ThisExpression' && n.property?.type === 'Identifier') {
      const prop = n.property.name;
      const svc = host.injected.get(prop);
      if (svc && parent?.type === 'MemberExpression' && parent.object === n && !parent.computed && parent.property?.type === 'Identifier') {
        const member = parent.property.name;
        refs.set(`${prop}.${member}`, { key: `${prop}.${member}`, kind: 'service', name: svc, member });
      } else if (!svc && prop !== self && host.decls.get(prop)?.method) {
        refs.set(prop, { key: prop, kind: 'local', name: prop });
      }
      return;
    }
    if (n.type !== 'Identifier') return;
    if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
    if ((parent?.type === 'ObjectProperty' || parent?.type === 'ClassProperty' || parent?.type === 'ClassMethod') && key === 'key' && !parent.computed) return;
    if (/^TS/.test(parent?.type ?? '')) return; // type positions
    const name = n.name;
    if (own.has(name)) return;
    const imp = host.imports.get(name);
    if (imp) {
      if (imp.imported === '*') {
        if (parent?.type === 'MemberExpression' && parent.object === n && !parent.computed && parent.property?.type === 'Identifier') {
          const member = parent.property.name;
          refs.set(`${name}.${member}`, { key: `${name}.${member}`, kind: 'ns', name, member });
        }
        return;
      }
      refs.set(name, { key: name, kind: 'import', name });
      return;
    }
    const local = host.decls.get(name);
    // A binding declared INSIDE the definition (a param, a local) is not a dependency.
    if (!local || within(local.def) || local.def.type === 'ClassDeclaration') return;
    if (factoryOf(local.def, host)) {
      // Store/hook instance alias: track the accessed MEMBER (tasks.claimTask), so an
      // edit to a sibling action does not flag; bare use falls back to the whole factory.
      if (parent?.type === 'MemberExpression' && parent.object === n && !parent.computed && parent.property?.type === 'Identifier') {
        const member = parent.property.name;
        refs.set(`${name}.${member}`, { key: `${name}.${member}`, kind: 'alias', name, member });
      } else refs.set(name, { key: name, kind: 'alias', name });
      return;
    }
    refs.set(name, { key: name, kind: 'local', name });
  });
  return [...refs.values()];
}

interface TsPaths { dir: string; baseUrl: string | null; paths: [string, string[]][] }

/** Shared, cached module access for one pipeline run. */
export class ModuleGraph {
  private files = new Map<string, { code: string; program: Node | null } | null>();
  private tsconfigs = new Map<string, TsPaths | null>();

  private load(path: string) {
    if (!this.files.has(path)) {
      let entry: { code: string; program: Node | null } | null = null;
      try {
        const code = readFileSync(path, 'utf8');
        entry = { code, program: parseModule(code, path) };
      } catch {
        entry = null;
      }
      this.files.set(path, entry);
    }
    return this.files.get(path)!;
  }

  private tryFile(base: string): string | null {
    const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base, 'index' + e))];
    for (const c of candidates) {
      try {
        if (statSync(c).isFile()) return c;
      } catch {
        /* not there */
      }
    }
    return null;
  }

  private tsPathsFor(fromDir: string): TsPaths | null {
    if (this.tsconfigs.has(fromDir)) return this.tsconfigs.get(fromDir)!;
    let found: TsPaths | null = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const p = join(fromDir, name);
      if (!existsSync(p)) continue;
      try {
        const opts = JSON.parse(stripJsonc(readFileSync(p, 'utf8')))?.compilerOptions ?? {};
        found = {
          dir: fromDir,
          baseUrl: opts.baseUrl != null ? resolve(fromDir, opts.baseUrl) : null,
          paths: Object.entries((opts.paths ?? {}) as Record<string, string[]>),
        };
      } catch {
        found = null;
      }
      break;
    }
    if (!found) {
      const up = dirname(fromDir);
      found = up === fromDir ? null : this.tsPathsFor(up);
    }
    this.tsconfigs.set(fromDir, found);
    return found;
  }

  /** Resolve a specifier to a file; 'bare' = a package (out of scope by design). */
  resolveSpecifier(spec: string, fromPath: string): string | null | 'bare' {
    const fromDir = dirname(resolve(fromPath));
    if (spec.startsWith('.') || spec.startsWith('/')) return this.tryFile(resolve(fromDir, spec));
    const ts = this.tsPathsFor(fromDir);
    if (ts) {
      for (const [pattern, targets] of ts.paths) {
        const star = pattern.indexOf('*');
        const hit = star === -1 ? (spec === pattern ? '' : null)
          : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1))
            ? spec.slice(star, spec.length - (pattern.length - star - 1)) : null;
        if (hit == null) continue;
        for (const t of targets) {
          const f = this.tryFile(resolve(ts.baseUrl ?? ts.dir, t.replace('*', hit)));
          if (f) return f;
        }
        return null; // matched an alias but nothing on disk: unresolved, not bare
      }
      if (ts.baseUrl) {
        const f = this.tryFile(resolve(ts.baseUrl, spec));
        if (f) return f;
      }
    }
    return LOCAL_ALIAS_PREFIX.test(spec) ? null : 'bare';
  }

  /** The declaration text a module exports under `name` (re-exports followed). */
  exportText(file: string, name: string, member?: string, hops = 0, seen = new Set<string>()): string | null {
    const tag = `${file}#${name}`;
    if (hops > MAX_REEXPORT_HOPS || seen.has(tag)) return null;
    seen.add(tag);
    const mod = this.load(file);
    if (!mod?.program) return null;
    const { code, program } = mod;
    const slice = (n: Node) => code.slice(n.start, n.end);
    // With `member`, slice only that member's definition inside the export (a class
    // method, a store action, a hook's returned function); null if it is not there.
    const sliceDecl = (stmt: Node, _decl?: Node): string | null => (member ? findMember(stmt, member, code) : slice(stmt));
    const follow = (source: string, imported: string) => {
      const f = this.resolveSpecifier(source, file);
      return typeof f === 'string' && f !== 'bare' ? this.exportText(f, imported, member, hops + 1, seen) : null;
    };
    const localDecl = (local: string): string | null => {
      for (const stmt of program.body) {
        const d = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id?.name === local) return sliceDecl(stmt, d);
        if (d.type === 'VariableDeclaration' && d.declarations.some((x: Node) => patternNames(x.id).includes(local))) return sliceDecl(stmt);
        if (stmt.type === 'ImportDeclaration') {
          const s = (stmt.specifiers ?? []).find((x: Node) => x.local?.name === local);
          if (s) {
            const imp = s.type === 'ImportDefaultSpecifier' ? 'default' : (s.imported?.name ?? s.imported?.value);
            return s.type === 'ImportNamespaceSpecifier' ? null : follow(stmt.source.value, imp);
          }
        }
      }
      return null;
    };
    for (const stmt of program.body) {
      if (stmt.type === 'ExportNamedDeclaration') {
        const d = stmt.declaration;
        if (d) {
          if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id?.name === name) return sliceDecl(stmt, d);
          if (d.type === 'VariableDeclaration' && d.declarations.some((x: Node) => patternNames(x.id).includes(name))) return sliceDecl(stmt);
          continue;
        }
        for (const s of stmt.specifiers ?? []) {
          const exported = s.exported?.name ?? s.exported?.value;
          if (exported !== name) continue;
          const local = s.local?.name ?? s.local?.value;
          return stmt.source ? follow(stmt.source.value, local) : localDecl(local);
        }
      } else if (stmt.type === 'ExportDefaultDeclaration' && name === 'default') {
        const d = stmt.declaration;
        if (d.type === 'Identifier') return localDecl(d.name);
        return sliceDecl(stmt, d);
      }
    }
    for (const stmt of program.body) {
      if (stmt.type === 'ExportAllDeclaration' && !stmt.exported && name !== 'default') {
        const t = follow(stmt.source.value, name);
        if (t != null) return t;
      }
    }
    return null;
  }

  /** Resolve the layer-2 deps of each referenced name in one host script. */
  resolve(names: string[], ctx: ScriptContext): DepResolution {
    const out: DepResolution = { byName: {}, unresolved: [] };
    const program = parseModule(ctx.code, ctx.path);
    if (!program) return out;
    const host = indexHost(program, ctx.code);
    const viaImport = (ref: string, imp: ImportBinding, member?: string): string | null => {
      const file = this.resolveSpecifier(imp.source, ctx.path);
      if (file === 'bare') return null;
      const exportName = imp.imported === '*' ? member! : imp.imported;
      const text = file ? this.exportText(file, exportName, imp.imported === '*' ? undefined : member) : null;
      if (text == null) out.unresolved.push(`${imp.source}#${member && imp.imported !== '*' ? `${exportName}.${member}` : exportName}`);
      return text;
    };
    for (const name of names) {
      const deps: Record<string, string> = {};
      const imp = host.imports.get(name);
      if (imp && imp.imported !== '*') {
        // A template-referenced import: its own declaration IS the hop.
        const t = viaImport(name, imp);
        if (t != null) deps[`${name}>${name}`] = t;
      } else {
        const local = host.decls.get(name);
        if (local) {
          for (const r of collectRefs(local.def, name, host)) {
            let text: string | null = null;
            if (r.kind === 'local') {
              const d = host.decls.get(r.name)!;
              text = ctx.code.slice(d.slice.start, d.slice.end);
            } else if (r.kind === 'alias') {
              const d = host.decls.get(r.name)!;
              const callee = factoryOf(d.def, host)!;
              const factory = host.imports.get(callee)!;
              // Member slice when it can be found; else the whole factory (safe over-flag).
              const file = this.resolveSpecifier(factory.source, ctx.path);
              const viaMember = r.member && typeof file === 'string' && file !== 'bare'
                ? this.exportText(file, factory.imported, r.member) : null;
              const ft = viaMember ?? viaImport(callee, factory);
              // The declaration itself always counts; a bare-package factory (ref,
              // computed, useRouter) contributes nothing more — out of scope by design.
              text = ctx.code.slice(d.slice.start, d.slice.end) + (ft == null ? '' : '\n' + ft);
            } else if (r.kind === 'import') {
              text = viaImport(r.key, host.imports.get(r.name)!);
            } else if (r.kind === 'ns') {
              text = viaImport(r.key, host.imports.get(r.name)!, r.member);
            } else if (r.kind === 'service') {
              const svcImport = host.imports.get(r.name);
              if (svcImport) text = viaImport(r.key, svcImport, r.member);
              else {
                const d = host.decls.get(r.name);
                const m = d?.def?.body?.body?.find((x: Node) => x.key?.name === r.member);
                text = m ? ctx.code.slice(m.start, m.end) : null;
              }
            }
            if (text != null) deps[`${name}>${r.key}`] = text;
          }
        }
      }
      out.byName[name] = deps;
    }
    out.unresolved = [...new Set(out.unresolved)].sort();
    return out;
  }
}

/**
 * The definition of `member` inside an exported declaration: a function / variable
 * named so (a hook's inner `const save = …`), an object method or non-shorthand
 * property (a store action, a returned `save: …`), or a class member. First match
 * in source order wins; null when absent.
 */
function findMember(root: Node, member: string, code: string): string | null {
  let hit: Node | null = null;
  walk(root, (n) => {
    if (hit) return false;
    const keyName = n.key?.type === 'Identifier' ? n.key.name : n.key?.value;
    if (
      (n.type === 'FunctionDeclaration' && n.id?.name === member) ||
      (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.id.name === member) ||
      ((n.type === 'ObjectMethod' || n.type === 'ClassMethod' || n.type === 'ClassProperty') && keyName === member && !n.computed) ||
      (n.type === 'ObjectProperty' && keyName === member && !n.computed && !n.shorthand)
    ) {
      hit = n;
      return false;
    }
  });
  return hit ? code.slice((hit as Node).start, (hit as Node).end) : null;
}

/** Strip // and block comments plus trailing commas from JSONC (string-aware). */
function stripJsonc(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
