import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AngularAdapter } from '../../src/adapters/angular';
import { ElementNode } from '../../src/core/types';
import { normalizeSignals } from '../../src/core/signals';
import { selectIdentityKey } from '../../src/core/identity';
import { fingerprintOf } from '../../src/core/fingerprint';

const TPL = `<form [formGroup]="form" (ngSubmit)="onSubmit()">
  <h1>Sign in</h1>
  <input type="email" formControlName="email" placeholder="you@x" />
  <button type="submit" [disabled]="!form.valid" (click)="save($event)">Save</button>
  <tr *ngFor="let u of users"><td><button (click)="edit(u)">Edit</button></td></tr>
  <a [attr.data-testid]="'row-' + u.id" routerLink="/x">X</a>
  <ng-container><span aria-label="hi">Hi</span></ng-container>
</form>`;

const nodes: ElementNode[] = new AngularAdapter().parse(TPL, 'p.component.html', 'p');
const by = (tag: string) => nodes.filter((n) => n.tag === tag);

describe('AngularAdapter.parse', () => {
  it('maps outputs to event_handlers and inputs to bound identifier paths', () => {
    const form = by('form')[0];
    expect(form.signals.event_handlers).toMatchObject({ ngsubmit: 'onSubmit' });
    expect(form.signals.bound_identifiers).toMatchObject({ formgroup: 'form' });
    const btn = by('button')[0];
    expect(btn.signals.event_handlers).toMatchObject({ click: 'save' });
    expect(btn.signals.bound_identifiers).toMatchObject({ disabled: 'form.valid' });
  });

  it('maps formControlName, routerLink, text and plain attributes', () => {
    expect(by('input')[0].signals).toMatchObject({ form_control: 'email', type: 'email', placeholder: 'you@x' });
    expect(by('h1')[0].signals.text).toBe('Sign in');
    expect(by('span')[0].signals.aria_label).toBe('hi');
  });

  it('marks the *ngFor subtree as inLoop', () => {
    expect(by('tr')[0].inLoop).toBe(true);
    expect(by('td')[0].inLoop).toBe(true);
    expect(by('button')[1].inLoop).toBe(true);   // Edit
    expect(by('button')[0].inLoop ?? false).toBe(false); // Save
  });

  it('skips author-bound [attr.data-testid] elements and ng-container wrappers', () => {
    expect(by('a')).toHaveLength(0);
    expect(by('ng-container')).toHaveLength(0);
    expect(by('span')).toHaveLength(1); // ng-container child still visited
  });

  it('records arrow-safe opening-tag locations', () => {
    const btn = by('button')[0];
    expect(TPL.slice(btn.loc!.start, btn.loc!.start + 7)).toBe('<button');
    expect(TPL[btn.loc!.end]).toBe('>');
  });
});

describe('AngularAdapter.write (idempotent)', () => {
  it('does not duplicate the attribute on re-run', () => {
    const a = new AngularAdapter();
    const ns = a.parse(TPL, 'p.component.html', 'p');
    const btn = ns.find((n) => n.tag === 'button')!;
    const once = a.write(TPL, [{ loc: btn.loc!, attributeName: 'data-testid', id: 'p__button--save' }]);
    const btn2 = a.parse(once, 'p.component.html', 'p').find((n) => n.tag === 'button')!;
    const twice = a.write(once, [{ loc: btn2.loc!, attributeName: 'data-testid', id: 'p__button--save' }]);
    expect(twice).toBe(once);
    expect(once).toContain('(click)="save($event)" data-testid="p__button--save">');
  });
});

describe('AngularAdapter.resolveSymbolDefs (companion .ts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tu-ng-'));
  const html = join(dir, 'login.component.html');
  writeFileSync(html, '<button (click)="onSubmit()">Go</button>');
  writeFileSync(join(dir, 'login.component.ts'), `import { api } from './api';
const LIMIT = 3;
export class LoginComponent {
  count = 0;
  onSubmit() {
    if (this.count < LIMIT) api.send();
  }
}
`);

  it('resolves class members, top-level consts and imports', () => {
    const defs = new AngularAdapter().resolveSymbolDefs!(['onSubmit', 'LIMIT', 'api', 'nope'], '', html);
    expect(defs.onSubmit).toContain('onSubmit() {');
    expect(defs.LIMIT).toBe('const LIMIT = 3;');
    expect(defs.api).toBe("import { api } from './api';");
    expect(defs.nope).toBeNull();
  });

  it('degrades to all-null when no companion file exists', () => {
    const defs = new AngularAdapter().resolveSymbolDefs!(['x'], '', join(dir, 'missing.component.html'));
    expect(defs.x).toBeNull();
  });
});

describe('AngularAdapter raw binding expressions (fingerprint-only)', () => {
  it('a pipe added inside a binding changes the fingerprint but not identity', () => {
    const adapter = new AngularAdapter();
    const before = adapter.parse('<img [src]="p.image" />', 'profile.component.html', 'profile')[0];
    const after = adapter.parse('<img [src]="p.image | defaultImage" />', 'profile.component.html', 'profile')[0];
    const nb = normalizeSignals(before.signals);
    const na = normalizeSignals(after.signals);
    expect(selectIdentityKey(nb, 'img').value).toBe(selectIdentityKey(na, 'img').value);
    expect(fingerprintOf('img', nb)).not.toBe(fingerprintOf('img', na));
  });

  it('a handler argument change flags the fingerprint while the handler key holds', () => {
    const adapter = new AngularAdapter();
    const before = adapter.parse('<button (click)="save(item)">S</button>', 'a.component.html', 'a')[0];
    const after = adapter.parse('<button (click)="save(item, true)">S</button>', 'a.component.html', 'a')[0];
    const nb = normalizeSignals(before.signals);
    const na = normalizeSignals(after.signals);
    expect(selectIdentityKey(nb, 'button').value).toBe('save');
    expect(selectIdentityKey(na, 'button').value).toBe('save');
    expect(fingerprintOf('button', nb)).not.toBe(fingerprintOf('button', na));
  });
});

describe('AngularAdapter resolveSymbolDefs on export-default classes', () => {
  it('finds members of an `export default class` (the realworld settings pattern)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ngdef-'));
    const tpl = join(dir, 'settings.component.html');
    writeFileSync(tpl, '<form (ngSubmit)="submitForm()"></form>');
    writeFileSync(join(dir, 'settings.component.ts'), [
      'export default class SettingsComponent {',
      '  submitForm() { return 1; }',
      '}',
    ].join('\n'));
    const defs = new AngularAdapter().resolveSymbolDefs(['submitForm'], '', tpl);
    expect(defs.submitForm).toContain('submitForm() { return 1; }');
  });
});
