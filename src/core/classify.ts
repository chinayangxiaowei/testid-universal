/**
 * Element classification — pure policy.
 *
 * Produces a coarse {short, long} type per element. {short} feeds the readable
 * {element} token in an id (e.g. "input"); {long} is the descriptive element_type
 * stored in the registry (e.g. "native_input_email").
 *
 * Component libraries (PrimeNG, MUI, Vuetify, …) authored as custom tags are the
 * "vocabulary" the adapter knows about: an adapter supplies a customTagMap so a
 * <p-dropdown> classifies as a select-like control instead of an unknown element.
 */
import { ElementNode, ElementType, CoreConfig } from './types';

const NATIVE: Record<string, (node: ElementNode) => ElementType> = {
  input: (n) => ({ short: 'input', long: `native_input_${(n.semantic.type ?? 'text') || 'text'}` }),
  textarea: () => ({ short: 'textarea', long: 'native_textarea' }),
  select: () => ({ short: 'select', long: 'native_select' }),
  button: () => ({ short: 'button', long: 'native_button' }),
  a: () => ({ short: 'link', long: 'native_link' }),
  form: () => ({ short: 'form', long: 'native_form' }),
  label: () => ({ short: 'label', long: 'native_label' }),
  img: () => ({ short: 'img', long: 'native_img' }),
};

export function classify(node: ElementNode, config: CoreConfig): ElementType {
  const custom = config.customTagMap[node.tag] ?? config.customTagMap[node.tag.toLowerCase()];
  if (custom) return { short: custom.short, long: custom.long };

  const native = NATIVE[node.tag.toLowerCase()];
  if (native) return native(node);

  const short = node.tag.toLowerCase();
  return { short, long: `element_${short}` };
}
