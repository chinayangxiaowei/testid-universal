import { describe, it, expect } from 'vitest';
import { selectIdentityKey, identityOf } from '../../src/core/identity';
import { normalizeSignals } from '../../src/core/signals';

const sig = (raw: Parameters<typeof normalizeSignals>[0]) => normalizeSignals(raw);

describe('selectIdentityKey', () => {
  it('prefers code-wired signals over display copy', () => {
    const r = selectIdentityKey(sig({ form_control: 'email', text: 'Email address', aria_label: 'Email' }), 'input');
    expect(r).toMatchObject({ value: 'email', source: 'form_control', stable: true });
  });

  it('ranks explicit_key highest', () => {
    const r = selectIdentityKey(sig({ explicit_key: 'login/submit', form_control: 'x' }), 'button');
    expect(r).toMatchObject({ value: 'login/submit', source: 'explicit_key', stable: true });
  });

  it('places html_id below form_control/name/route', () => {
    const r = selectIdentityKey(sig({ html_id: 'cust-dd', route: '/x' }), 'a');
    expect(r.source).toBe('route');
  });

  it('falls to copy only as a last resort and marks it unstable', () => {
    const r = selectIdentityKey(sig({ text: 'Sign in' }), 'button');
    expect(r).toMatchObject({ value: 'Sign in', source: 'text', stable: false });
  });

  it('falls back to the tag when nothing is present (unstable)', () => {
    const r = selectIdentityKey(sig({}), 'section');
    expect(r).toMatchObject({ value: 'section', source: 'tag', stable: false });
  });

  it('picks a deterministic preferred event handler', () => {
    const r = selectIdentityKey(sig({ event_handlers: { blur: 'onBlur', click: 'saveOrder' } }), 'button');
    expect(r).toMatchObject({ value: 'saveOrder', source: 'event_handlers' });
  });
});

describe('identityOf', () => {
  it('joins component, element short and slugified key', () => {
    expect(identityOf('login', 'input', 'email')).toBe('login::input::email');
  });
});
