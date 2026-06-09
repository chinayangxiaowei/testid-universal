/**
 * Core types — the framework-agnostic contract.
 *
 * Everything in `core/` operates ONLY on these types. No HTML, no JSX, no Vue.
 * A framework adapter's single job is to turn its templates into `ElementNode[]`
 * (and later to write assigned ids back). That boundary is what makes the engine
 * portable across Angular / React / Vue / anything that renders a DOM.
 */

/**
 * Canonical, framework-neutral semantic hints.
 *
 * Each framework has its own vocabulary (Angular `formControlName`, React `name`,
 * Vue `v-model`, RouterLink vs `to`, …). The ADAPTER maps those into these
 * canonical keys; the CORE only ever reasons about the canonical names. This is
 * the single most important seam: vocabulary = adapter, policy = core.
 */
export interface SemanticHints {
  field_name: string | null;    // form control identity (Angular formControlName, React/HTML name, Vue v-model target)
  name: string | null;          // generic name attribute
  aria_label: string | null;    // accessibility label
  placeholder: string | null;   // input placeholder
  text_content: string | null;  // direct visible text
  route: string | null;         // routerLink / <Link to> / <router-link to>
  role: string | null;          // ARIA role
  type: string | null;          // input type, button type, etc.
}

export const SEMANTIC_KEYS: (keyof SemanticHints)[] = [
  'field_name', 'name', 'aria_label', 'placeholder', 'text_content', 'route', 'role', 'type',
];

/** A source position so an adapter can write the assigned id back. Adapter-defined. */
export interface SourceLoc {
  file: string;
  start: number;
  end: number;
}

/**
 * The intermediate representation. One per taggable element, produced by an adapter.
 */
export interface ElementNode {
  /** Logical owner of the element, e.g. "login" or a template path. Used for {component}. */
  component: string;
  /** Tag exactly as authored: "input", "p-dropdown", "MyButton". Used for classification + {tag}. */
  tag: string;
  /** Canonical semantic hints, already normalized by the adapter. */
  semantic: Partial<SemanticHints>;
  /** Optional extra attributes the adapter wants folded into the fingerprint for stability. */
  extraAttrs?: Record<string, string | null>;
  /** Position for write-back (optional; runtime adapters can omit it). */
  loc?: SourceLoc;
  /** If the element already carried a hand-written testid. */
  existingId?: string | null;
}

/** Coarse element classification, e.g. {short:"input", long:"native_input_email"}. */
export interface ElementType {
  short: string;
  long: string;
}

/** A computed-but-not-yet-reconciled assignment for one element. Pure output of the engine. */
export interface EntryDraft {
  id: string;
  component: string;
  tag: string;
  element_type: string;
  fingerprint: string;
  semantic: Partial<SemanticHints>;
  key: string;
  loc?: SourceLoc;
}

export interface CustomTagMapEntry { short: string; long: string; }

export interface CoreConfig {
  /** Priority order for choosing {key}. First non-empty wins; falls back to the tag name. */
  keyPriority: (keyof SemanticHints)[];
  /** Naming template. Tokens: {component} {element} {key} {tag} {hash} {hash:-} plus literals. */
  idFormat: string;
  /** The attribute that will hold the id, e.g. "data-testid" or "data-cy". */
  attributeName: string;
  hashAlgorithm: 'sha256' | 'sha1' | 'md5';
  hashLength: number;                       // 4..16
  collisionStrategy: 'hash-suffix' | 'error';
  customTagMap: Record<string, CustomTagMapEntry>;
  /** Tag names that should never be tagged. */
  ignoreTags: string[];
}

export const DEFAULT_CONFIG: CoreConfig = {
  // aria_label first mirrors the original tool's "most-meaningful label wins" intent.
  keyPriority: ['aria_label', 'field_name', 'name', 'placeholder', 'text_content', 'route'],
  idFormat: '{component}__{element}--{key}{hash:-}',
  attributeName: 'data-testid',
  hashAlgorithm: 'sha256',
  hashLength: 6,
  collisionStrategy: 'hash-suffix',
  customTagMap: {},
  ignoreTags: [],
};
