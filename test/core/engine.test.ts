import { describe, it, expect } from 'vitest';
import { generate, shouldTag } from '../../src/core/engine';
import { DEFAULT_CONFIG, CoreConfig } from '../../src/core/types';
import { node } from '../helpers';

const cfg: CoreConfig = DEFAULT_CONFIG;

describe('shouldTag', () => {
  it('skips elements with no semantic signal and no existing id', () => {
    expect(shouldTag(node({ tag: 'div', semantic: {} }), cfg)).toBe(false);
  });

  it('tags elements carrying any semantic hint', () => {
    expect(shouldTag(node({ tag: 'input', semantic: { field_name: 'email' } }), cfg)).toBe(true);
  });

  it('always tags elements that already carry a hand-written id', () => {
    expect(shouldTag(node({ tag: 'div', semantic: {}, existingId: 'x' }), cfg)).toBe(true);
  });

  it('respects ignoreTags', () => {
    const config = { ...cfg, ignoreTags: ['svg'] };
    expect(shouldTag(node({ tag: 'svg', semantic: { aria_label: 'icon' } }), config)).toBe(false);
  });
});

describe('generate', () => {
  it('produces clean, hash-free ids when there is no collision', () => {
    const drafts = generate([
      node({ tag: 'input', semantic: { field_name: 'email', type: 'email' } }),
      node({ tag: 'button', semantic: { text_content: 'Sign in' } }),
    ], cfg);
    expect(drafts.map((d) => d.id)).toEqual(['login__input--email', 'login__button--sign-in']);
  });

  it('is a pure function of (nodes, config) — identical input, identical ids', () => {
    const nodes = [node({ tag: 'input', semantic: { field_name: 'email', type: 'email' } })];
    expect(generate(nodes, cfg).map((d) => d.id)).toEqual(generate(nodes, cfg).map((d) => d.id));
  });

  it('adds a hash suffix ONLY when the same base id has distinct fingerprints', () => {
    // Both slug to login__input--email, but different fingerprints (type differs).
    const drafts = generate([
      node({ tag: 'input', semantic: { field_name: 'email', type: 'email' } }),
      node({ tag: 'input', semantic: { field_name: 'email', type: 'text' } }),
    ], cfg);
    expect(drafts).toHaveLength(2);
    for (const d of drafts) expect(d.id).toMatch(/^login__input--email-[0-9a-f]{6}$/);
    expect(drafts[0].id).not.toBe(drafts[1].id);
  });

  it('does NOT add a hash when colliding elements are genuinely identical', () => {
    // Same base id AND same fingerprint -> not contested -> shared clean id.
    const same = { tag: 'input', semantic: { field_name: 'email', type: 'email' } } as const;
    const drafts = generate([node({ ...same }), node({ ...same })], cfg);
    expect(drafts.every((d) => d.id === 'login__input--email')).toBe(true);
  });

  it('throws on collision when collisionStrategy is "error"', () => {
    const config = { ...cfg, collisionStrategy: 'error' as const };
    expect(() => generate([
      node({ tag: 'input', semantic: { field_name: 'email', type: 'email' } }),
      node({ tag: 'input', semantic: { field_name: 'email', type: 'text' } }),
    ], config)).toThrow(/collision/);
  });

  it('carries fingerprint, key and element_type through to the draft', () => {
    const [d] = generate([node({ tag: 'input', semantic: { field_name: 'email', type: 'email' } })], cfg);
    expect(d).toMatchObject({ key: 'email', element_type: 'native_input_email', component: 'login' });
    expect(d.fingerprint).toContain('field_name=email');
  });
});
