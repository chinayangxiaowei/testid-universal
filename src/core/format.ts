/**
 * Id formatting. Tokens: {component} {element} {key} {tag} {disambiguator}
 * {disambiguator:--}. The `:--` form expands to "--<value>" only when a
 * disambiguator is present, keeping the common unique case clean.
 */
export interface IdTokens {
  component: string;
  element: string;
  key: string;
  tag: string;
  disambiguator: string;
}

export function formatId(template: string, t: IdTokens): string {
  return template
    .replace(/\{disambiguator:--\}/g, t.disambiguator ? `--${t.disambiguator}` : '')
    .replace(/\{component\}/g, t.component)
    .replace(/\{element\}/g, t.element)
    .replace(/\{key\}/g, t.key)
    .replace(/\{tag\}/g, t.tag)
    .replace(/\{disambiguator\}/g, t.disambiguator);
}
