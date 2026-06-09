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
});
