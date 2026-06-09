import { describe, it, expect } from 'vitest';
import { classify } from '../../src/core/classify';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { node } from '../helpers';

describe('classify', () => {
  it('encodes the input type into the long element_type', () => {
    expect(classify(node({ tag: 'input', semantic: { type: 'email' } }), DEFAULT_CONFIG))
      .toEqual({ short: 'input', long: 'native_input_email' });
  });

  it('defaults input type to text when absent', () => {
    expect(classify(node({ tag: 'input', semantic: {} }), DEFAULT_CONFIG))
      .toEqual({ short: 'input', long: 'native_input_text' });
  });

  it('classifies common native tags', () => {
    expect(classify(node({ tag: 'button' }), DEFAULT_CONFIG).long).toBe('native_button');
    expect(classify(node({ tag: 'a' }), DEFAULT_CONFIG)).toEqual({ short: 'link', long: 'native_link' });
  });

  it('falls back to element_<tag> for unknown tags', () => {
    expect(classify(node({ tag: 'my-widget' }), DEFAULT_CONFIG))
      .toEqual({ short: 'my-widget', long: 'element_my-widget' });
  });

  it('lets a customTagMap override classification (the adapter vocabulary seam)', () => {
    const config = { ...DEFAULT_CONFIG, customTagMap: { 'p-dropdown': { short: 'select', long: 'primeng_dropdown' } } };
    expect(classify(node({ tag: 'p-dropdown' }), config)).toEqual({ short: 'select', long: 'primeng_dropdown' });
  });
});
