/**
 * Vue adapter — the first real (AST-backed) FrameworkAdapter.
 *
 * Unlike the regex-based HtmlTemplateAdapter, this parses the SFC with the official
 * @vue/compiler-sfc, walks the real template AST, and normalizes Vue's vocabulary
 * (v-model, :to / router-link, native attrs, text) into canonical RawSignals.
 * Everything downstream — ids, registry, diff, locators — is untouched: the adapter
 * is the ONLY framework-aware seam.
 *
 * @vue/compiler-sfc is an OPTIONAL peer dependency. It is lazily required so that
 * consumers who never touch Vue keep the package's zero-runtime-dependency profile.
 */
import { ElementNode, RawSignals } from '../core/types';
import { FrameworkAdapter, applyTestIdEdits } from './contract';
import { Edit } from '../server/service';

// Minimal shapes we read off the @vue/compiler-dom AST (typed loosely on purpose).
interface VueLoc { start: { offset: number }; end: { offset: number } }
interface VueNode { type: number; tag?: string; props?: VueProp[]; children?: VueNode[]; loc: VueLoc; content?: string }
interface VueProp {
  type: number;            // 6 = AttributeNode, 7 = DirectiveNode
  name: string;            // attr name, or directive name ('model' | 'bind' | 'on' | ...)
  value?: { content: string };
  arg?: { content: string };
  exp?: { content: string };
}

const NODE_ELEMENT = 1;
const NODE_TEXT = 2;
const PROP_ATTRIBUTE = 6;
const PROP_DIRECTIVE = 7;

type VueSfc = {
  parse: (source: string, opts?: { filename?: string }) => { descriptor: any; errors: unknown[] };
  compileScript: (descriptor: any, opts: { id: string }) => { scriptSetupAst?: any[] };
};

function loadVueSfc(): VueSfc {
  try {
    return require('@vue/compiler-sfc') as VueSfc;
  } catch {
    throw new Error(
      'VueAdapter requires the optional peer dependency "@vue/compiler-sfc". Install it: npm i -D @vue/compiler-sfc',
    );
  }
}

/** Example component-library map: Vuetify components -> native-equivalent classification. */
export const VUETIFY_TAG_MAP: Record<string, { short: string; long: string }> = {
  'v-text-field': { short: 'input', long: 'vuetify_text_field' },
  'v-textarea': { short: 'textarea', long: 'vuetify_textarea' },
  'v-select': { short: 'select', long: 'vuetify_select' },
  'v-checkbox': { short: 'checkbox', long: 'vuetify_checkbox' },
  'v-btn': { short: 'button', long: 'vuetify_btn' },
  'v-form': { short: 'form', long: 'vuetify_form' },
};

function readProps(node: VueNode) {
  const attrs: Record<string, string> = {};
  const bound: Record<string, string> = {};
  const events: Record<string, string> = {};
  let model: string | null = null;
  for (const p of node.props ?? []) {
    if (p.type === PROP_ATTRIBUTE) attrs[p.name] = p.value?.content ?? '';
    else if (p.type === PROP_DIRECTIVE) {
      if (p.name === 'model') model = p.exp?.content ?? null;
      else if (p.name === 'bind' && p.arg?.content) bound[p.arg.content] = firstIdentifierPath(p.exp?.content ?? '');
      else if (p.name === 'on' && p.arg?.content) events[p.arg.content] = handlerName(p.exp?.content ?? '');
    }
  }
  return { attrs, bound, events, model };
}

/** First identifier path in a bind expression: "!form.email || x" -> "form.email". */
function firstIdentifierPath(expr: string): string {
  const m = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(expr);
  return m ? m[0] : expr.trim();
}

/** Reduce a handler expression to a function name: "login" / "save()" -> "login"/"save". */
function handlerName(expr: string): string {
  const m = /^\s*([A-Za-z_$][\w$]*)\s*\(?/.exec(expr);
  return m ? m[1] : expr.trim();
}

function directText(node: VueNode): string | null {
  const text = (node.children ?? [])
    .filter((c) => c.type === NODE_TEXT)
    .map((c) => c.content ?? '')
    .join('')
    .trim();
  return text || null;
}

function normalize(node: VueNode): RawSignals {
  const { attrs, bound, events, model } = readProps(node);
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (attrs[k] != null && attrs[k] !== '') return attrs[k];
      if (bound[k] != null && bound[k] !== '') return bound[k];
    }
    return null;
  };
  const signals: RawSignals = {
    explicit_key: pick('data-tid'),
    form_control: model ?? pick('name'),
    name: pick('name'),
    route: pick('to', 'href'),
    event_handlers: events,
    bound_identifiers: bound,
    html_id: pick('id'),
    aria_label: pick('aria-label'),
    placeholder: pick('placeholder'),
    type: pick('type'),
    role: pick('role'),
  };
  const text = directText(node);
  if (text) signals.text = text;
  return signals;
}

export class VueAdapter implements FrameworkAdapter {
  readonly name = 'vue';
  customTagMap: Record<string, { short: string; long: string }>;

  constructor(customTagMap: Record<string, { short: string; long: string }> = {}) {
    this.customTagMap = customTagMap;
  }

  parse(source: string, file: string, component: string): ElementNode[] {
    const root = loadVueSfc().parse(source).descriptor.template?.ast as VueNode | undefined;
    if (!root) return [];

    const nodes: ElementNode[] = [];
    const visit = (node: VueNode, inLoop: boolean) => {
      const hasFor = (node.props ?? []).some((p) => p.type === PROP_DIRECTIVE && p.name === 'for');
      const loop = inLoop || hasFor;
      // <template> is a non-rendering wrapper (slots, v-if groups): an attribute on
      // it never reaches the DOM, so tagging it would mint a dead id.
      if (node.type === NODE_ELEMENT && node.tag && node.tag.toLowerCase() !== 'template') {
        const { attrs, bound } = readProps(node);
        // An author-bound testid (e.g. :data-testid="'row-' + u.id") is the correct
        // per-instance fix for loops; respect it: never mint a static id next to it.
        const hasBoundTestid = bound['data-testid'] != null || bound['data-cy'] != null;
        if (!hasBoundTestid) {
          const start = node.loc.start.offset;
          const tagEnd = source.indexOf('>', start);
          nodes.push({
            component,
            tag: node.tag,
            signals: normalize(node),
            existingId: attrs['data-testid'] ?? attrs['data-cy'] ?? null,
            loc: { file, start, end: tagEnd },
            inLoop: loop,
          });
        }
      }
      for (const child of node.children ?? []) visit(child, loop);
    };
    visit(root, false);
    return nodes;
  }

  write(source: string, edits: Edit[]): string {
    return applyTestIdEdits(source, edits);
  }

  /**
   * L2 resolver: map referenced names to their <script setup> top-level definition
   * text. Imported names resolve to their import statement only (opaque boundary);
   * names with no top-level declaration (template locals, options API) yield null.
   */
  resolveSymbolDefs(names: string[], source: string, file: string): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const n of names) out[n] = null;
    const sfc = loadVueSfc();
    const { descriptor } = sfc.parse(source, { filename: file });
    if (!descriptor.scriptSetup) return out;
    let ast: any[] | undefined;
    try {
      ast = sfc.compileScript(descriptor, { id: file }).scriptSetupAst;
    } catch {
      // compileScript rejects some valid-JS constructs (e.g. top-level `export` in
      // <script setup>). Fall through to the @babel/parser fallback below.
    }
    const content: string = descriptor.scriptSetup.content;
    // When compileScript did not produce an AST, parse the raw script content
    // directly with @babel/parser — the same underlying parser @vue/compiler-sfc uses.
    if (!ast) {
      try {
        const bp = require('@babel/parser') as { parse: (src: string, opts?: any) => any };
        const parsed = bp.parse(content, { sourceType: 'module', plugins: ['typescript'] });
        ast = parsed.program?.body ?? [];
      } catch {
        return out; // unparsable script: resolve nothing rather than something wrong
      }
    }
    if (!ast) return out;
    const slice = (node: any) => content.slice(node.start, node.end);
    for (const node of ast) {
      // export function f() {} / export const x = ... wrap the declaration node.
      const decl = node.type === 'ExportNamedDeclaration' && node.declaration ? node.declaration : node;
      if (decl.type === 'FunctionDeclaration' && decl.id && names.includes(decl.id.name)) {
        out[decl.id.name] = slice(node);
      } else if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (d.id?.type === 'Identifier' && names.includes(d.id.name)) out[d.id.name] = slice(node);
        }
      } else if (decl.type === 'ImportDeclaration') {
        for (const s of decl.specifiers ?? []) {
          if (names.includes(s.local?.name)) out[s.local.name] = slice(node);
        }
      }
    }
    return out;
  }
}
