/**
 * Id formatting — renders the configured idFormat template against the tokens the
 * engine computed.
 *
 * Tokens: {component} {element} {key} {tag} {hash} {hash:-}
 *
 * {hash:-} is the readability knob from the design: it expands to "-<hash>" ONLY
 * when a hash is present (i.e. a real collision), and to "" otherwise — so the
 * common, collision-free case yields a clean id with no dangling separator.
 */
export interface IdTokens {
  component: string;
  element: string;
  key: string;
  tag: string;
  hash: string;
}

export function formatId(template: string, tokens: IdTokens): string {
  return template
    .replace(/\{hash:-\}/g, tokens.hash ? `-${tokens.hash}` : '')
    .replace(/\{component\}/g, tokens.component)
    .replace(/\{element\}/g, tokens.element)
    .replace(/\{key\}/g, tokens.key)
    .replace(/\{tag\}/g, tokens.tag)
    .replace(/\{hash\}/g, tokens.hash);
}
