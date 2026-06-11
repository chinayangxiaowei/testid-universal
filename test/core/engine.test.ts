import { describe, it, expect } from 'vitest';
import { generate, shouldTag } from '../../src/core/engine';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { node } from '../helpers';

const cfg = DEFAULT_CONFIG;

describe('shouldTag', () => {
  it('skips elements with no signal and no existing id', () => {
    expect(shouldTag(node({ tag: 'div', signals: {} }), cfg)).toBe(false);
  });
  it('tags elements carrying any signal', () => {
    expect(shouldTag(node({ tag: 'input', signals: { form_control: 'email' } }), cfg)).toBe(true);
  });
  it('respects ignoreTags', () => {
    expect(shouldTag(node({ tag: 'svg', signals: { aria_label: 'icon' } }), { ...cfg, ignoreTags: ['svg'] })).toBe(false);
  });
  it('skips copy-only presentation tags (skipTags) by default', () => {
    expect(shouldTag(node({ tag: 'h1', signals: { text: 'Welcome' } }), cfg)).toBe(false);
    expect(shouldTag(node({ tag: 'th', signals: { text: 'Name' } }), cfg)).toBe(false);
    expect(shouldTag(node({ tag: 'label', signals: { text: 'Remember me' } }), cfg)).toBe(false);
  });
  it('keeps a skipTags element that carries an explicit key', () => {
    expect(shouldTag(node({ tag: 'h1', signals: { explicit_key: 'page/title', text: 'Welcome' } }), cfg)).toBe(true);
  });
  it('keeps a skipTags element that already has a written id (sticky)', () => {
    expect(shouldTag(node({ tag: 'h1', signals: { text: 'Welcome' }, existingId: 'x__h1--old' }), cfg)).toBe(true);
  });
});

describe('generate', () => {
  it('derives a clean id from a stable code-wired key', () => {
    const { drafts } = generate([
      node({ tag: 'input', signals: { form_control: 'email', type: 'email' } }),
      node({ tag: 'button', signals: { event_handlers: { click: 'login' }, text: 'Sign in' } }),
    ], cfg);
    expect(drafts.map((d) => d.id)).toEqual(['login__input--email', 'login__button--login']);
  });

  it('does NOT change an element id when an unrelated element is added', () => {
    const a = node({ tag: 'input', signals: { form_control: 'email' } });
    const idAlone = generate([a], cfg).drafts[0].id;
    const idWithSibling = generate([a, node({ tag: 'input', signals: { form_control: 'password' } })], cfg)
      .drafts.find((d) => d.identity.endsWith('::email'))!.id;
    expect(idWithSibling).toBe(idAlone);
  });

  it('keeps a stable id when only display copy changes', () => {
    const v1 = generate([node({ tag: 'button', signals: { event_handlers: { click: 'login' }, text: 'Sign in' } })], cfg);
    const v2 = generate([node({ tag: 'button', signals: { event_handlers: { click: 'login' }, text: 'Login' } })], cfg);
    expect(v2.drafts[0].id).toBe(v1.drafts[0].id);
    expect(v2.drafts[0].fingerprint).not.toBe(v1.drafts[0].fingerprint);
  });

  it('disambiguates identical siblings so every id is unique, with a warning', () => {
    const { drafts, warnings } = generate([
      node({ tag: 'button', signals: { text: 'Delete' } }),
      node({ tag: 'button', signals: { text: 'Delete' } }),
    ], cfg);
    const ids = drafts.map((d) => d.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(['login__button--delete', 'login__button--delete--2']);
    expect(warnings.some((w) => w.code === 'positional-disambiguator')).toBe(true);
  });

  it('warns when identity falls back to display copy', () => {
    const { warnings } = generate([node({ tag: 'button', signals: { text: 'Save' } })], cfg);
    expect(warnings.some((w) => w.code === 'unstable-identity')).toBe(true);
  });

  it('prefers a distinguishing stable signal over a positional index', () => {
    const { drafts } = generate([
      node({ tag: 'a', signals: { text: 'Open', route: '/a' } }),
      node({ tag: 'a', signals: { text: 'Open', route: '/b' } }),
    ], cfg);
    expect(new Set(drafts.map((d) => d.id)).size).toBe(2);
    expect(drafts.every((d) => !d.id.includes('--2'))).toBe(true);
  });

  it('keeps ids unique when a stable token would clash with a positional index', () => {
    // Same identity (key = form_control "email"); one has html_id "2", the other has no stable token.
    const { drafts } = generate([
      node({ tag: 'input', signals: { form_control: 'email', html_id: '2' } }),
      node({ tag: 'input', signals: { form_control: 'email' } }),
    ], cfg);
    expect(new Set(drafts.map((d) => d.id)).size).toBe(2);
    expect(drafts.map((d) => d.id)).toEqual(['login__input--email', 'login__input--email--2']);
  });

  it('slugifies a custom element short in the id', () => {
    const cfg2 = { ...cfg, customTagMap: { My_Widget: { short: 'My_Widget', long: 'custom' } } };
    const { drafts } = generate([node({ tag: 'My_Widget', signals: { form_control: 'x' } })], cfg2);
    expect(drafts[0].id).toBe('login__my-widget--x');
  });

  it('keeps an existing written id verbatim instead of recomputing', () => {
    const { drafts } = generate([
      node({ tag: 'input', signals: { form_control: 'email' }, existingId: 'legacy__input--whatever' }),
    ], cfg);
    expect(drafts[0].id).toBe('legacy__input--whatever');
    expect(drafts[0].sticky).toBe(true);
  });

  it('does not warn about a volatile key when the element already has an id', () => {
    const { warnings } = generate([
      node({ tag: 'button', signals: { text: 'Save' }, existingId: 'x__button--save' }),
    ], cfg);
    expect(warnings.some((w) => w.code === 'unstable-identity')).toBe(false);
  });

  it('mints a fresh id that does not collide with a sticky id of the same identity', () => {
    const { drafts } = generate([
      node({ tag: 'button', signals: { text: 'Save' }, existingId: 'login__button--save' }),
      node({ tag: 'button', signals: { text: 'Save' } }),
    ], cfg);
    const ids = drafts.map((d) => d.id);
    expect(ids).toContain('login__button--save');
    expect(new Set(ids).size).toBe(2);
  });

  it('warns about loop multiplicity for an element inside a loop', () => {
    const { warnings } = generate([
      node({ tag: 'button', signals: { event_handlers: { click: 'edit' } }, inLoop: true }),
    ], cfg);
    expect(warnings.some((w) => w.code === 'loop-multiplicity')).toBe(true);
  });

  it('does not emit a loop warning for a normal element', () => {
    const { warnings } = generate([
      node({ tag: 'button', signals: { event_handlers: { click: 'edit' } } }),
    ], cfg);
    expect(warnings.some((w) => w.code === 'loop-multiplicity')).toBe(false);
  });

  it('slugifies the component token so the id matches the identity casing', () => {
    const { drafts } = generate([
      node({ component: 'LoginPage', tag: 'input', signals: { form_control: 'email' } }),
    ], cfg);
    // slugify lowercases (no camelCase splitting); the point is id casing == identity casing.
    expect(drafts[0].id).toBe('loginpage__input--email');
    expect(drafts[0].identity).toBe('loginpage::input::email');
  });

  it('keeps positional slots stable across reordering when a prior registry is given', () => {
    // Same identity (key from the click handler); fingerprints differ by text.
    const A = node({ tag: 'button', signals: { event_handlers: { click: 'save' }, text: 'Save' } });
    const B = node({ tag: 'button', signals: { event_handlers: { click: 'save' }, text: 'Submit' } });
    const v1 = generate([A, B], cfg);
    const prior = v1.drafts.map((d) => ({ identity: d.identity, fingerprint: d.fingerprint, disambiguator: d.disambiguator }));
    const v2 = generate([B, A], cfg, prior); // reordered
    const idOf = (r: typeof v1, fp: string) => r.drafts.find((d) => d.fingerprint === fp)!.id;
    for (const d of v1.drafts) {
      expect(idOf(v2, d.fingerprint)).toBe(d.id); // each element keeps its v1 id despite reorder
    }
  });

  it('hashes attached symbol sources into the draft', () => {
    const { drafts } = generate([
      node({
        tag: 'button',
        signals: { event_handlers: { click: 'saveOrder' } },
        symbol_sources: { saveOrder: 'function saveOrder() { return 1; }' },
      }),
    ], cfg);
    expect(Object.keys(drafts[0].symbol_defs)).toEqual(['saveOrder']);
    expect(drafts[0].symbol_defs.saveOrder).toMatch(/^[0-9a-f]{12}$/);
  });

  it('tracks symbol_defs for sticky elements too (id frozen, deps still tracked)', () => {
    const { drafts } = generate([
      node({
        tag: 'button',
        signals: { event_handlers: { click: 'saveOrder' } },
        existingId: 'x__button--save',
        symbol_sources: { saveOrder: 'function saveOrder() { return 1; }' },
      }),
    ], cfg);
    expect(drafts[0].sticky).toBe(true);
    expect(Object.keys(drafts[0].symbol_defs)).toEqual(['saveOrder']);
  });

  it('a new group member takes the next free slot without moving incumbents', () => {
    const A = node({ tag: 'button', signals: { event_handlers: { click: 'save' }, text: 'Save' } });
    const B = node({ tag: 'button', signals: { event_handlers: { click: 'save' }, text: 'Submit' } });
    const v1 = generate([A, B], cfg);
    const prior = v1.drafts.map((d) => ({ identity: d.identity, fingerprint: d.fingerprint, disambiguator: d.disambiguator }));
    const C = node({ tag: 'button', signals: { event_handlers: { click: 'save' }, text: 'Apply' } });
    const v2 = generate([C, A, B], cfg, prior); // C inserted FIRST in document order
    const byFp = (r: typeof v2, fp: string) => r.drafts.find((d) => d.fingerprint === fp)!;
    for (const d of v1.drafts) expect(byFp(v2, d.fingerprint).id).toBe(d.id); // incumbents unmoved
    const cDraft = v2.drafts.find((d) => !v1.drafts.some((x) => x.fingerprint === d.fingerprint))!;
    expect(cDraft.id).toBe('login__button--save--3'); // newcomer takes next free slot
  });

  it('falls back to the tag when the selected key slugifies to nothing', () => {
    const { drafts, warnings } = generate([
      node({ tag: 'span', signals: { text: '()' } }),
    ], cfg);
    expect(drafts[0].id).toBe('login__span--span');
    expect(drafts[0].identity).toBe('login::span::span');
    expect(warnings.some((w) => w.code === 'unstable-identity')).toBe(true);
  });
});
