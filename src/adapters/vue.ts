/**
 * Vue adapter — the first real (AST-backed) FrameworkAdapter.
 *
 * Unlike the regex-based HtmlTemplateAdapter, this parses the SFC with the official
 * @vue/compiler-sfc, walks the real template AST, and normalizes Vue's vocabulary
 * (v-model, :to / router-link, native attrs, text) into canonical SemanticHints.
 * Everything downstream — ids, registry, diff, locators — is untouched: the adapter
 * is the ONLY framework-aware seam.
 *
 * @vue/compiler-sfc is an OPTIONAL peer dependency. It is lazily required so that
 * consumers who never touch Vue keep the package's zero-runtime-dependency profile.
 */
import { ElementNode, SemanticHints } from '../core/types';
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
  let model: string | null = null;
  for (const p of node.props ?? []) {
    if (p.type === PROP_ATTRIBUTE) {
      attrs[p.name] = p.value?.content ?? '';
    } else if (p.type === PROP_DIRECTIVE) {
      if (p.name === 'model') model = p.exp?.content ?? null;
      else if (p.name === 'bind' && p.arg?.content) bound[p.arg.content] = p.exp?.content ?? '';
    }
  }
  return { attrs, bound, model };
}

function directText(node: VueNode): string | null {
  const text = (node.children ?? [])
    .filter((c) => c.type === NODE_TEXT)
    .map((c) => c.content ?? '')
    .join('')
    .trim();
  return text || null;
}

function normalize(node: VueNode): Partial<SemanticHints> {
  const { attrs, bound, model } = readProps(node);
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (attrs[k] != null && attrs[k] !== '') return attrs[k];
      if (bound[k] != null && bound[k] !== '') return bound[k];
    }
    return null;
  };
  const semantic: Partial<SemanticHints> = {
    field_name: model ?? pick('name'),
    name: pick('name'),
    aria_label: pick('aria-label'),
    placeholder: pick('placeholder'),
    route: pick('to', 'href'),
    type: pick('type'),
  };
  const text = directText(node);
  if (text) semantic.text_content = text;
  return semantic;
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
    const visit = (node: VueNode) => {
      if (node.type === NODE_ELEMENT && node.tag) {
        const attrs = readProps(node).attrs;
        const start = node.loc.start.offset;
        // Opening tag ends at the first '>' from the start (matches the write contract).
        const tagEnd = source.indexOf('>', start);
        nodes.push({
          component,
          tag: node.tag,
          semantic: normalize(node),
          existingId: attrs['data-testid'] ?? attrs['data-cy'] ?? null,
          loc: { file, start, end: tagEnd },
        });
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
    return nodes;
  }

  write(source: string, edits: Edit[]): string {
    return applyTestIdEdits(source, edits);
  }
}
