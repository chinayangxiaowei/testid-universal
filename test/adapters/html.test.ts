import { describe, it, expect } from 'vitest';
import { HtmlTemplateAdapter } from '../../src/adapters/html';

const SRC = `<form>
  <input name="email" type="email" placeholder="you@x" aria-label="Email">
  <a routerlink="/forgot">Forgot?</a>
  <button type="submit">Sign in</button>
</form>`;

describe('HtmlTemplateAdapter.parse', () => {
  const nodes = new HtmlTemplateAdapter().parse(SRC, 'login.html', 'login');
  const byTag = (t: string) => nodes.find((n) => n.tag === t)!;

  it('maps name/type/placeholder/aria-label into signals', () => {
    expect(byTag('input').signals).toMatchObject({ name: 'email', type: 'email', placeholder: 'you@x', aria_label: 'Email' });
  });
  it('maps routerlink/href into route and captures text', () => {
    expect(byTag('a').signals.route).toBe('/forgot');
    expect(byTag('a').signals.text).toBe('Forgot?');
  });
  it('captures button text', () => {
    expect(byTag('button').signals.text).toBe('Sign in');
  });
});

describe('HtmlTemplateAdapter.write (idempotent)', () => {
  it('does not duplicate the attribute on re-run', () => {
    const a = new HtmlTemplateAdapter();
    const nodes = a.parse(SRC, 'login.html', 'login');
    const btn = nodes.find((n) => n.tag === 'button')!;
    const once = a.write(SRC, [{ loc: btn.loc!, attributeName: 'data-testid', id: 'login__button--login' }]);
    const btn2 = a.parse(once, 'login.html', 'login').find((n) => n.tag === 'button')!;
    const twice = a.write(once, [{ loc: btn2.loc!, attributeName: 'data-testid', id: 'login__button--login' }]);
    expect(twice).toBe(once);
  });
});
