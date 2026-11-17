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
 * resolved is reported in `unresolved` — never silently treated as unchanged. What a
 * hop-1 definition itself depends on (layer 3: a local helper, a relative import, an
 * injected service) and dynamic dispatch (`obj[key]()`, calling a parameter) are
 * reported in `limited` — not hashed, not a change signal, but never silently green.
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
  /**
   * referenced symbol name -> sorted dependencies beyond tracking depth:
   * "<name>><ref>><layer3>" or "<name>>[<ref>>](dynamic) <callee>".
   */
  limited: Record<string, string[]>;
}

/** A sliced declaration plus where it lives, so what IT depends on can be inspected. */
interface Located { text: string; file: string; node: Node; self: string }

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
  // Parameters of any function inside the definition shadow module-level bindings
  // (the module index is not scope-aware: `claim(id)` must not resolve to another
  // function's `const id`). Name-level, so a param also hides a same-named outer ref.
  walk(def, (n) => {
    if (/Function|ClassMethod|ObjectMethod/.test(n.type)) for (const p of n.params ?? []) patternNames(p).forEach((x) => own.add(x));
  });
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
  private hosts = new Map<string, HostIndex | null>();

  private hostOf(file: string): HostIndex | null {
    if (!this.hosts.has(file)) {
      const mod = this.load(file);
      this.hosts.set(file, mod?.program ? indexHost(mod.program, mod.code) : null);
    }
    return this.hosts.get(file)!;
  }

  /**
   * What a hop-1 definition itself depends on that is NOT tracked: local helpers,
   * relative/aliased imports, injected services (layer 3), plus dynamic dispatch.
   * Bare packages and globals stay out of scope, as everywhere else.
   */
  private beyond(loc: { node: Node; self: string; file: string; host: HostIndex }): string[] {
    const out: string[] = [];
    const notBare = (source: string) => this.resolveSpecifier(source, loc.file) !== 'bare';
    for (const r of collectRefs(loc.node, loc.self, loc.host)) {
      if (r.kind === 'local' || r.kind === 'service') out.push(r.key);
      else if (r.kind === 'import' || r.kind === 'ns') {
        if (notBare(loc.host.imports.get(r.name)!.source)) out.push(r.key);
      } else if (r.kind === 'alias') {
        const callee = factoryOf(loc.host.decls.get(r.name)!.def, loc.host)!;
        if (notBare(loc.host.imports.get(callee)!.source)) out.push(r.key);
      }
    }
    // `this.<m>()` outside a known class (an options-object store action calling a
    // sibling action, `this.persist()`): a real dependency the index cannot slice.
    walk(loc.node, (n) => {
      const c = n.type === 'CallExpression' ? n.callee : null;
      if (c?.type === 'MemberExpression' && !c.computed && c.object?.type === 'ThisExpression' && c.property?.type === 'Identifier') {
        const m = c.property.name;
        if (m !== loc.self && !out.includes(m) && !out.some((k) => k.startsWith(`${m}.`))) out.push(`this.${m}`);
      }
    });
    return [...new Set(out), ...dynamicCalls(loc.node, loc.host.code)];
  }

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
  exportText(file: string, name: string, member?: string): string | null {
    return this.exportDecl(file, name, member)?.text ?? null;
  }

  /** Like exportText, but also returns the declaration node and its file. */
  exportDecl(file: string, name: string, member?: string, hops = 0, seen = new Set<string>()): Located | null {
    const tag = `${file}#${name}`;
    if (hops > MAX_REEXPORT_HOPS || seen.has(tag)) return null;
    seen.add(tag);
    const mod = this.load(file);
    if (!mod?.program) return null;
    const { code, program } = mod;
    // With `member`, slice only that member's definition inside the export (a class
    // method, a store action, a hook's returned function); null if it is not there.
    const sliceDecl = (stmt: Node, _decl?: Node): Located | null => {
      const n = member ? findMemberNode(stmt, member) : stmt;
      return n ? { text: code.slice(n.start, n.end), file, node: n, self: member ?? name } : null;
    };
    const follow = (source: string, imported: string): Located | null => {
      const f = this.resolveSpecifier(source, file);
      return typeof f === 'string' && f !== 'bare' ? this.exportDecl(f, imported, member, hops + 1, seen) : null;
    };
    const localDecl = (local: string): Located | null => {
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
    const out: DepResolution = { byName: {}, unresolved: [], limited: {} };
    const program = parseModule(ctx.code, ctx.path);
    if (!program) return out;
    const host = indexHost(program, ctx.code);
    const viaImport = (ref: string, imp: ImportBinding, member?: string): Located | null => {
      const file = this.resolveSpecifier(imp.source, ctx.path);
      if (file === 'bare') return null;
      const exportName = imp.imported === '*' ? member! : imp.imported;
      const loc = file ? this.exportDecl(file, exportName, imp.imported === '*' ? undefined : member) : null;
      if (loc == null) out.unresolved.push(`${imp.source}#${member && imp.imported !== '*' ? `${exportName}.${member}` : exportName}`);
      return loc;
    };
    const hostLoc = (node: Node, self: string): Located =>
      ({ text: ctx.code.slice(node.start, node.end), file: ctx.path, node, self });
    for (const name of names) {
      const deps: Record<string, string> = {};
      const limited: string[] = [];
      const noteBeyond = (prefix: string, loc: Located | null) => {
        const h = loc && (loc.file === ctx.path ? host : this.hostOf(loc.file));
        if (loc && h) for (const b of this.beyond({ ...loc, host: h })) limited.push(`${prefix}>${b}`);
      };
      const imp = host.imports.get(name);
      if (imp && imp.imported !== '*') {
        // A template-referenced import: its own declaration IS the hop.
        const t = viaImport(name, imp);
        if (t != null) { deps[`${name}>${name}`] = t.text; noteBeyond(`${name}>${name}`, t); }
      } else {
        const local = host.decls.get(name);
        if (local) {
          for (const d of dynamicCalls(local.def, ctx.code)) limited.push(`${name}>${d}`);
          for (const r of collectRefs(local.def, name, host)) {
            let text: string | null = null;
            let loc: Located | null = null;
            if (r.kind === 'local') {
              const d = host.decls.get(r.name)!;
              text = ctx.code.slice(d.slice.start, d.slice.end);
              loc = hostLoc(d.def, r.name);
            } else if (r.kind === 'alias') {
              const d = host.decls.get(r.name)!;
              const callee = factoryOf(d.def, host)!;
              const factory = host.imports.get(callee)!;
              // Member slice when it can be found; else the whole factory (safe over-flag).
              const file = this.resolveSpecifier(factory.source, ctx.path);
              const viaMember = r.member && typeof file === 'string' && file !== 'bare'
                ? this.exportDecl(file, factory.imported, r.member) : null;
              const ft = viaMember ?? viaImport(callee, factory);
              // The declaration itself always counts; a bare-package factory (ref,
              // computed, useRouter) contributes nothing more — out of scope by design.
              text = ctx.code.slice(d.slice.start, d.slice.end) + (ft == null ? '' : '\n' + ft.text);
              loc = ft;
            } else if (r.kind === 'import') {
              loc = viaImport(r.key, host.imports.get(r.name)!);
            } else if (r.kind === 'ns') {
              loc = viaImport(r.key, host.imports.get(r.name)!, r.member);
            } else if (r.kind === 'service') {
              const svcImport = host.imports.get(r.name);
              if (svcImport) loc = viaImport(r.key, svcImport, r.member);
              else {
                const d = host.decls.get(r.name);
                const m = d?.def?.body?.body?.find((x: Node) => x.key?.name === r.member);
                loc = m ? hostLoc(m, r.member!) : null;
              }
            }
            text ??= loc?.text ?? null;
            if (text != null) { deps[`${name}>${r.key}`] = text; noteBeyond(`${name}>${r.key}`, loc); }
          }
        }
      }
      out.byName[name] = deps;
      out.limited[name] = [...new Set(limited)].sort();
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
  const n = findMemberNode(root, member);
  return n ? code.slice(n.start, n.end) : null;
}

function findMemberNode(root: Node, member: string): Node | null {
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
  return hit;
}

/**
 * Calls whose target cannot be known statically: a computed member call with a
 * non-literal key (`handlers[mode]()`, `this[name]()`) or calling a parameter of a
 * function inside `root` (a callback). Labelled `(dynamic) <callee source>`.
 */
function dynamicCalls(root: Node, code: string): string[] {
  const params = new Set<string>();
  walk(root, (n) => {
    if (/Function|ClassMethod|ObjectMethod/.test(n.type)) for (const p of n.params ?? []) patternNames(p, []).forEach((x) => params.add(x));
  });
  const out: string[] = [];
  walk(root, (n) => {
    if (n.type !== 'CallExpression' && n.type !== 'OptionalCallExpression') return;
    const c = n.callee;
    const literalKey = (k: Node) => k?.type === 'StringLiteral' || k?.type === 'NumericLiteral';
    if ((c?.type === 'MemberExpression' || c?.type === 'OptionalMemberExpression') && c.computed && !literalKey(c.property)) {
      out.push(`(dynamic) ${code.slice(c.start, c.end).replace(/\s+/g, ' ').slice(0, 60)}`);
    } else if (c?.type === 'Identifier' && params.has(c.name)) {
      out.push(`(dynamic) ${c.name}`);
    }
  });
  return out;
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
