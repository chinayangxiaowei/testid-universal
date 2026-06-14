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

describe('HtmlTemplateAdapter *ngFor loop detection', () => {
  const TPL = `<table>
  <tr><th>Name</th></tr>
  <tr *ngFor="let u of users">
    <td>{{ u.name }}</td>
    <td><button (click)="edit(u)">Edit</button></td>
  </tr>
</table>
<button (click)="save()">Save</button>`;

  it('marks the *ngFor element and elements inside its subtree as inLoop', () => {
    const nodes = new HtmlTemplateAdapter().parse(TPL, 'u.html', 'users');
    const by = (pred: (n: any) => boolean) => nodes.filter(pred);
    const loopTr = by((n) => n.tag === 'tr')[1];
    expect(loopTr.inLoop).toBe(true);
    const buttons = by((n) => n.tag === 'button');
    expect(buttons[0].inLoop).toBe(true);   // Edit, inside the loop
    expect(buttons[1].inLoop ?? false).toBe(false); // Save, outside
    expect(by((n) => n.tag === 'th')[0].inLoop ?? false).toBe(false);
  });
});

describe('HtmlTemplateAdapter skips non-content tags', () => {
  it('does not emit nodes for script / style / title (never test targets)', () => {
    const adapter = new HtmlTemplateAdapter();
    const src = '<title>Hi</title><script>var x = 1; if (x) doThing();</script><style>.a{color:red}</style><button>Go</button>';
    const tags = adapter.parse(src, 'a.html', 'a').map((n) => n.tag);
    expect(tags).not.toContain('script');
    expect(tags).not.toContain('style');
    expect(tags).not.toContain('title');
    expect(tags).toContain('button');
  });
});
