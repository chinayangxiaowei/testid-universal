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
});
