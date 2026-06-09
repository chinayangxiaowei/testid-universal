import { NormalizedSignals, ElementType, CoreConfig } from './types';

const NATIVE: Record<string, (sig: NormalizedSignals) => ElementType> = {
  input: (s) => ({ short: 'input', long: `native_input_${s.type ?? 'text'}` }),
  textarea: () => ({ short: 'textarea', long: 'native_textarea' }),
  select: () => ({ short: 'select', long: 'native_select' }),
  button: () => ({ short: 'button', long: 'native_button' }),
  a: () => ({ short: 'link', long: 'native_link' }),
  form: () => ({ short: 'form', long: 'native_form' }),
  label: () => ({ short: 'label', long: 'native_label' }),
  img: () => ({ short: 'img', long: 'native_img' }),
};

export function classify(tag: string, sig: NormalizedSignals, config: CoreConfig): ElementType {
  const custom = config.customTagMap[tag] ?? config.customTagMap[tag.toLowerCase()];
  if (custom) return { short: custom.short, long: custom.long };
  const native = NATIVE[tag.toLowerCase()];
  if (native) return native(sig);
  const short = tag.toLowerCase();
  return { short, long: `element_${short}` };
}
