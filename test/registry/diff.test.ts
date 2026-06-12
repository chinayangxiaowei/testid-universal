import { describe, it, expect } from 'vitest';
import { diff } from '../../src/registry/diff';
import { snapshot, entry } from '../helpers';
import { normalizeSignals } from '../../src/core/signals';

const e = (identity: string, raw: Parameters<typeof normalizeSignals>[0], fp: string) =>
  entry({ identity, fingerprint: fp, signals: normalizeSignals(raw) });

describe('diff (exact identity match)', () => {
  it('unchanged when identity and fingerprint match', () => {
    const v1 = snapshot(1, { a: e('login::input::email', { form_control: 'email' }, 'F') });
    const v2 = snapshot(2, { a: e('login::input::email', { form_control: 'email' }, 'F') });
    expect(diff(v1, v2).summary.unchanged).toBe(1);
  });

  it('modified with a field-level change list when copy changes', () => {
    const v1 = snapshot(1, { b: e('login::button::login', { event_handlers: { click: 'go' }, text: 'Sign in' }, 'F1') });
    const v2 = snapshot(2, { b: e('login::button::login', { event_handlers: { click: 'go' }, text: 'Login' }, 'F2') });
    const d = diff(v1, v2);
    expect(d.summary.modified).toBe(1);
    expect(d.modified[0].changes).toContainEqual({ field: 'text', old: 'Sign in', new: 'Login' });
  });

  it('added / removed by identity, no fuzzy matching', () => {
    const v1 = snapshot(1, { gone: e('login::a::old', { route: '/old' }, 'X') });
    const v2 = snapshot(2, { fresh: e('login::a::new', { route: '/new' }, 'Y') });
    const d = diff(v1, v2);
    expect(d.summary).toMatchObject({ added: 1, removed: 1 });
    expect(d.added[0].id).toBe('fresh');
    expect(d.removed[0].id).toBe('gone');
  });

  it('regenerated when an unmatched id has multi-version history', () => {
    const v1 = snapshot(1, { other: e('login::a::o', { route: '/o' }, 'A') });
    const v2 = snapshot(2, {
      other: e('login::a::o', { route: '/o' }, 'A'),
      reborn: entry({ identity: 'login::a::r', fingerprint: 'B', generation_history: [1, 2] }),
    });
    const d = diff(v1, v2);
    expect(d.summary.regenerated).toBe(1);
    expect(d.regenerated[0].id).toBe('reborn');
  });

  it('reports a changed map field (event_handlers) in the change list', () => {
    const v1 = snapshot(1, { b: e('login::button::login', { event_handlers: { click: 'go' } }, 'F1') });
    const v2 = snapshot(2, { b: e('login::button::login', { event_handlers: { click: 'submit' } }, 'F2') });
    const d = diff(v1, v2);
    expect(d.modified[0].changes.some((c) => c.field === 'event_handlers')).toBe(true);
  });

  it('reports both elements of a same-identity group (no silent overwrite)', () => {
    const v1 = snapshot(1, {
      'login__button--save': entry({ identity: 'login::button::save', fingerprint: 'A' }),
      'login__button--save--2': entry({ identity: 'login::button::save', fingerprint: 'B' }),
    });
    const v2 = snapshot(2, {
      'login__button--save': entry({ identity: 'login::button::save', fingerprint: 'A' }),
    });
    const d = diff(v1, v2);
    expect(d.summary.unchanged).toBe(1);
    expect(d.summary.removed).toBe(1);
    expect(d.removed[0].id).toBe('login__button--save--2');
  });

  it('modified when only a symbol definition changed (fingerprint identical)', () => {
    const v1 = snapshot(1, { b: entry({ identity: 'x::button::save', fingerprint: 'F', symbol_defs: { saveOrder: 'aaa' } }) });
    const v2 = snapshot(2, { b: entry({ identity: 'x::button::save', fingerprint: 'F', symbol_defs: { saveOrder: 'bbb' } }) });
    const d = diff(v1, v2);
    expect(d.summary.modified).toBe(1);
    expect(d.modified[0].changes).toContainEqual({ field: 'symbol:saveOrder', old: 'aaa', new: 'bbb' });
  });

  it('unchanged when fingerprint and symbol_defs both match', () => {
    const v1 = snapshot(1, { b: entry({ identity: 'x::button::save', fingerprint: 'F', symbol_defs: { saveOrder: 'aaa' } }) });
    const v2 = snapshot(2, { b: entry({ identity: 'x::button::save', fingerprint: 'F', symbol_defs: { saveOrder: 'aaa' } }) });
    expect(diff(v1, v2).summary.unchanged).toBe(1);
  });

  it('stays unchanged when the previous entry predates symbol tracking (no baseline)', () => {
    const prev = entry({ identity: 'x::button::save', fingerprint: 'F' });
    delete (prev as any).symbol_defs; // simulate a pre-upgrade registry entry
    const v1 = snapshot(1, { b: prev });
    const v2 = snapshot(2, { b: entry({ identity: 'x::button::save', fingerprint: 'F', symbol_defs: { saveOrder: 'h1' } }) });
    expect(diff(v1, v2).summary.unchanged).toBe(1);
  });
});

describe('static_attributes change attribution', () => {
  it('names the changed catch-all key as attr:<key>', async () => {
    const { diffSignals } = await import('../../src/registry/diff');
    const { normalizeSignals } = await import('../../src/core/signals');
    const a = normalizeSignals({ event_handlers: { click: 'save' }, static_attributes: { '[src]': 'p.image' } });
    const b = normalizeSignals({ event_handlers: { click: 'save' }, static_attributes: { '[src]': 'p.image | defaultImage' } });
    const changes = diffSignals(a, b);
    expect(changes).toEqual([{ field: 'attr:[src]', old: 'p.image', new: 'p.image | defaultImage' }]);
  });
});
