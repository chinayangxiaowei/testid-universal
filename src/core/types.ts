/**
 * Core types — the framework-agnostic contract.
 *
 * Everything in `core/` operates ONLY on these types. No HTML, no JSX, no Vue.
 * A framework adapter's single job is to turn its templates into `ElementNode[]`
 * (and later to write assigned ids back). That boundary is what makes the engine
 * portable across Angular / React / Vue / anything that renders a DOM.
 */

/**
 * The closed signal contract every adapter fills. Tiered by stability:
 * Tier 0 explicit anchor, Tier 1 code-wired, Tier 2 structural, Tier 3 copy.
 * Identity is derived only from stable slots; `static_attributes` feeds the
 * fingerprint only and never influences identity.
 */
export interface RawSignals {
  explicit_key?: string | null;
  form_control?: string | null;
  name?: string | null;
  route?: string | null;
  event_handlers?: Record<string, string>;
  bound_identifiers?: Record<string, string>;
  html_id?: string | null;
  structural?: Record<string, string>;
  child_shape?: string[];
  context?: Record<string, string>;
  semantic_css?: string[];
  text?: string | null;
  aria_label?: string | null;
  placeholder?: string | null;
  title?: string | null;
  alt?: string | null;
  value?: string | null;
  type?: string | null;
  role?: string | null;
  static_attributes?: Record<string, string>;
}

/** RawSignals after normalization: every slot resolved (null / {} / []). */
export interface NormalizedSignals {
  explicit_key: string | null;
  form_control: string | null;
  name: string | null;
  route: string | null;
  event_handlers: Record<string, string>;
  bound_identifiers: Record<string, string>;
  html_id: string | null;
  structural: Record<string, string>;
  child_shape: string[];
  context: Record<string, string>;
  semantic_css: string[];
  text: string | null;
  aria_label: string | null;
  placeholder: string | null;
  title: string | null;
  alt: string | null;
  value: string | null;
  type: string | null;
  role: string | null;
  static_attributes: Record<string, string>;
}

export interface Warning {
  code: 'unstable-identity' | 'positional-disambiguator';
  element_type: string;
  identity: string;
  message: string;
}

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
  component: string;
  tag: string;
  signals: RawSignals;
  loc?: SourceLoc;
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
