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
  code: 'unstable-identity' | 'positional-disambiguator' | 'loop-multiplicity';
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
  /** True when this element is inside a loop (v-for / *ngFor): one static id will be
   *  shared by every rendered instance. Set by the adapter. */
  inLoop?: boolean;
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
  element_type: string;   // long form
  identity: string;       // stable matching key (no disambiguator)
  identity_key: string;   // slug used in {key}
  fingerprint: string;    // rich descriptive
  /** True when this id was taken verbatim from an already-written attribute (not minted). */
  sticky: boolean;
  /** Positional or stable-token disambiguator suffix; '' when none. */
  disambiguator: string;
  signals: NormalizedSignals;
  loc?: SourceLoc;
}

/** Minimal prior-registry view the engine needs for registry-stable disambiguation. */
export interface PriorEntry { identity: string; fingerprint: string; disambiguator: string }

export interface CustomTagMapEntry { short: string; long: string; }

export interface CoreConfig {
  /** Naming template. Tokens: {component} {element} {key} {tag} {disambiguator} {disambiguator:--}. */
  idFormat: string;
  attributeName: string;
  /** Attribute an adapter reads as the explicit stable key (Tier 0). */
  explicitKeyAttribute: string;
  customTagMap: Record<string, CustomTagMapEntry>;
  ignoreTags: string[];
}

export const DEFAULT_CONFIG: CoreConfig = {
  idFormat: '{component}__{element}--{key}{disambiguator:--}',
  attributeName: 'data-testid',
  explicitKeyAttribute: 'data-tid',
  customTagMap: {},
  ignoreTags: [],
};
