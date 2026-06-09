import { describe, it, expect } from 'vitest';
import { classify } from '../../src/core/classify';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { normalizeSignals } from '../../src/core/signals';

const cls = (tag: string, raw: Parameters<typeof normalizeSignals>[0], cfg = DEFAULT_CONFIG) =>
  classify(tag, normalizeSignals(raw), cfg);

describe('classify', () => {
  it('encodes input type into the long type', () => {
    expect(cls('input', { type: 'email' })).toEqual({ short: 'input', long: 'native_input_email' });
  });
  it('defaults input type to text', () => {
    expect(cls('input', {})).toEqual({ short: 'input', long: 'native_input_text' });
  });
  it('classifies common native tags', () => {
    expect(cls('button', {}).long).toBe('native_button');
    expect(cls('a', {})).toEqual({ short: 'link', long: 'native_link' });
  });
  it('falls back to element_<tag> for unknown tags', () => {
    expect(cls('my-widget', {})).toEqual({ short: 'my-widget', long: 'element_my-widget' });
  });
  it('lets customTagMap override', () => {
    const cfg = { ...DEFAULT_CONFIG, customTagMap: { 'v-btn': { short: 'button', long: 'vuetify_btn' } } };
    expect(cls('v-btn', {}, cfg)).toEqual({ short: 'button', long: 'vuetify_btn' });
  });
});
