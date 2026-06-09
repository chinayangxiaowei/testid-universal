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

type VueSfcParse = (source: string) => { descriptor: { template?: { ast?: VueNode } }; errors: unknown[] };

function loadVueParse(): VueSfcParse {
  try {
    return require('@vue/compiler-sfc').parse as VueSfcParse;
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
      else if (p.name === 'bind' && p.arg?.content) bound[p.arg.content] = p.exp?.content ?? '';
      else if (p.name === 'on' && p.arg?.content) events[p.arg.content] = handlerName(p.exp?.content ?? '');
    }
  }
  return { attrs, bound, events, model };
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
    const root = loadVueParse()(source).descriptor.template?.ast;
    if (!root) return [];

    const nodes: ElementNode[] = [];
    const visit = (node: VueNode, inLoop: boolean) => {
      const hasFor = (node.props ?? []).some((p) => p.type === PROP_DIRECTIVE && p.name === 'for');
      const loop = inLoop || hasFor;
      if (node.type === NODE_ELEMENT && node.tag) {
        const attrs = readProps(node).attrs;
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
      for (const child of node.children ?? []) visit(child, loop);
    };
    visit(root, false);
    return nodes;
  }

  write(source: string, edits: Edit[]): string {
    return applyTestIdEdits(source, edits);
  }
}
