import { describe, it, expect } from 'vitest';
import { ReactAdapter } from '../../src/adapters/react';
import { ElementNode } from '../../src/core/types';
import { normalizeSignals } from '../../src/core/signals';
import { selectIdentityKey } from '../../src/core/identity';
import { fingerprintOf } from '../../src/core/fingerprint';

const SRC = `import { useState } from 'react';
import { saveDraft } from './api';

const LIMIT = 3;

export default function LoginPage({ onDone }) {
  const [email, setEmail] = useState('');
  const submit = (e) => { e.preventDefault(); onDone(email); };
  return (
    <form onSubmit={submit} className="auth">
      <h1>Sign in</h1>
      <input type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <button type="submit" disabled={!email}>Sign in</button>
      <ul>{items.map((it) => <li key={it.id} onClick={() => pick(it)}>{it.name}</li>)}</ul>
      <img src={user.image} data-testid={'avatar-' + user.id} />
      <a href="/forgot">Forgot?</a>
    </form>
  );
}
`;

function parse(src = SRC): ElementNode[] {
  return new ReactAdapter().parse(src, 'LoginPage.tsx', 'LoginPage');
}

describe('ReactAdapter.parse', () => {
  it('maps on<Event> props to event_handlers, resolving arrow bodies to the called handler', () => {
    const nodes = parse();
    const form = nodes.find((n) => n.tag === 'form')!;
    expect(form.signals.event_handlers).toMatchObject({ submit: 'submit' });
    const li = nodes.find((n) => n.tag === 'li')!;
    expect(li.signals.event_handlers).toMatchObject({ click: 'pick' });
    const input = nodes.find((n) => n.tag === 'input')!;
    expect(input.signals.event_handlers).toMatchObject({ change: 'setEmail' });
  });

  it('maps expression props to bound_identifiers and raw expressions to static_attributes', () => {
    const nodes = parse();
    const input = nodes.find((n) => n.tag === 'input')!;
    expect(input.signals.bound_identifiers).toMatchObject({ value: 'email' });
    expect(input.signals.static_attributes!['{value}']).toBe('email');
    const button = nodes.find((n) => n.tag === 'button')!;
    expect(button.signals.static_attributes!['{disabled}']).toBe('!email');
  });

  it('excludes key/ref from bound_identifiers (loop bookkeeping, not wiring)', () => {
    const li = parse().find((n) => n.tag === 'li')!;
    expect(li.signals.bound_identifiers ?? {}).not.toHaveProperty('key');
  });

  it('fills named slots from string props and direct text', () => {
    const nodes = parse();
    const input = nodes.find((n) => n.tag === 'input')!;
    expect(input.signals.name).toBe('email');
    expect(input.signals.form_control).toBe('email');
    expect(input.signals.placeholder).toBe('Email');
    expect(input.signals.type).toBe('email');
    const a = nodes.find((n) => n.tag === 'a')!;
    expect(a.signals.route).toBe('/forgot');
    const button = nodes.find((n) => n.tag === 'button')!;
    expect(button.signals.text).toBe('Sign in');
  });

  it('marks elements inside .map() callbacks as inLoop', () => {
    const nodes = parse();
    expect(nodes.find((n) => n.tag === 'li')!.inLoop).toBe(true);
    expect(nodes.find((n) => n.tag === 'ul')!.inLoop).toBeFalsy();
    expect(nodes.find((n) => n.tag === 'button')!.inLoop).toBeFalsy();
  });

  it('respects an expression-valued data-testid by skipping the element entirely', () => {
    const nodes = parse();
    expect(nodes.find((n) => n.tag === 'img')).toBeUndefined();
  });

  it('adopts a string data-testid as existingId', () => {
    const nodes = parse('<button data-testid="b__x" onClick={save}>S</button>');
    expect(nodes[0].existingId).toBe('b__x');
  });

  it('loc.end points at the closing ">" for normal and self-closing tags', () => {
    const nodes = parse();
    for (const n of nodes) expect(SRC[n.loc!.end]).toBe('>');
  });

  it('an expression edit changes the fingerprint but not identity', () => {
    const a = parse('<img src={p.image} />')[0];
    const b = parse('<img src={p.image || FALLBACK_AVATAR} />')[0];
    const na = normalizeSignals(a.signals);
    const nb = normalizeSignals(b.signals);
    expect(selectIdentityKey(na, 'img').value).toBe(selectIdentityKey(nb, 'img').value);
    expect(fingerprintOf('img', na)).not.toBe(fingerprintOf('img', nb));
  });
});

describe('ReactAdapter.write', () => {
  it('writes ids at the opening tag and is idempotent', () => {
    const adapter = new ReactAdapter();
    const nodes = parse();
    const button = nodes.find((n) => n.tag === 'button')!;
    const edits = [{ loc: button.loc!, id: 'loginpage__button--submit', attributeName: 'data-testid' }];
    const once = adapter.write(SRC, edits);
    expect(once).toContain('data-testid="loginpage__button--submit"');
    const reparsed = new ReactAdapter().parse(once, 'LoginPage.tsx', 'LoginPage');
    const again = adapter.write(once, [
      { loc: reparsed.find((n) => n.tag === 'button')!.loc!, id: 'loginpage__button--submit', attributeName: 'data-testid' },
    ]);
    expect(again).toBe(once);
  });
});

describe('ReactAdapter.resolveSymbolDefs (same-file L2)', () => {
  it('slices component-body consts, top-level consts, and imports; unknown -> null', () => {
    const defs = new ReactAdapter().resolveSymbolDefs(
      ['submit', 'LIMIT', 'saveDraft', 'nope'],
      SRC,
      'LoginPage.tsx',
    );
    expect(defs.submit).toContain('e.preventDefault()');
    expect(defs.LIMIT).toContain('const LIMIT = 3;');
    expect(defs.saveDraft).toContain("import { saveDraft } from './api';");
    expect(defs.nope).toBeNull();
  });

  it('unwraps export default function declarations', () => {
    const src = 'export default function Page() { return <div onClick={go} />; }\nfunction go() { return 1; }';
    const defs = new ReactAdapter().resolveSymbolDefs(['Page', 'go'], src, 'P.tsx');
    expect(defs.Page).toContain('function Page()');
    expect(defs.go).toContain('function go() { return 1; }');
  });
});
