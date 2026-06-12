import { describe, it, expect } from 'vitest';
import { reconcile } from '../../src/registry/registry';
import { InMemoryStorage } from '../../src/registry/storage';
import { diff } from '../../src/registry/diff';
import { generate } from '../../src/core/engine';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { node, snapshot, entry } from '../helpers';

const button = () => node({ tag: 'button', signals: { event_handlers: { click: 'go' }, text: 'x' } });

const NOW = '2026-06-09T00:00:00.000Z';
const draftsFor = (...nodes: ReturnType<typeof node>[]) => generate(nodes, DEFAULT_CONFIG).drafts;
const emailInput = () => node({ tag: 'input', signals: { form_control: 'email', type: 'email' } });

describe('reconcile', () => {
  it('stamps first/last-seen and history on first appearance', async () => {
    const storage = new InMemoryStorage();
    const { snapshot: s } = await reconcile(draftsFor(emailInput()), storage, NOW);
    const e = s.entries['login__input--email'];

    expect(s.version).toBe(1);
    expect(e.source).toBe('generated');
    expect(e.first_seen_version).toBe(1);
    expect(e.last_seen_version).toBe(1);
    expect(e.generation_history).toEqual([1]);
    expect(e.last_generated_at).toBe(NOW);
  });

  it('advances last_seen but keeps first_seen across repeated runs', async () => {
    const storage = new InMemoryStorage();
    await reconcile(draftsFor(emailInput()), storage, NOW);
    const { snapshot: s2 } = await reconcile(draftsFor(emailInput()), storage, NOW);
    const e = s2.entries['login__input--email'];

    expect(s2.version).toBe(2);
    expect(e.first_seen_version).toBe(1); // unchanged
    expect(e.last_seen_version).toBe(2); // advanced
    expect(e.generation_history).toEqual([1]); // continuously present -> no new history mark
  });

  it('preserves a manual entry as source "manual" and reports it as an override', async () => {
    const storage = new InMemoryStorage();
    // Pre-seed a hand-authored entry at the id the engine will generate.
    await storage.save(snapshot(1, {
      'login__input--email': entry({ fingerprint: 'seed', source: 'manual' }),
    }));

    const { snapshot: s2, overrides } = await reconcile(draftsFor(emailInput()), storage, NOW);

    expect(overrides).toContain('login__input--email');
    expect(s2.entries['login__input--email'].source).toBe('manual');
  });

  it('increments version from the previous snapshot', async () => {
    const storage = new InMemoryStorage();
    await storage.save(snapshot(7, { 'x': entry({ fingerprint: 'f' }) }));
    const { snapshot: s } = await reconcile(draftsFor(emailInput()), storage, NOW);
    expect(s.version).toBe(8);
  });

  it('tracks regeneration: a dropped-then-readded id keeps first_seen and records the comeback', async () => {
    const storage = new InMemoryStorage();
    await reconcile(draftsFor(emailInput()), storage, NOW);  // v1: id present
    await reconcile(draftsFor(button()), storage, NOW);      // v2: id absent
    const { snapshot: s3 } = await reconcile(draftsFor(emailInput()), storage, NOW); // v3: id back

    const e = s3.entries['login__input--email'];
    expect(e.first_seen_version).toBe(1);          // preserved across the gap
    expect(e.last_seen_version).toBe(3);
    expect(e.generation_history).toEqual([1, 3]);  // comeback recorded
  });

  it('preserves a manual override even when the id disappears for a version', async () => {
    const storage = new InMemoryStorage();
    await storage.save(snapshot(1, {
      'login__input--email': entry({ fingerprint: 'seed', source: 'manual' }),
    }));
    await reconcile(draftsFor(button()), storage, NOW);                            // v2: manual id absent
    const { snapshot: s3, overrides } = await reconcile(draftsFor(emailInput()), storage, NOW); // v3: back

    expect(overrides).toContain('login__input--email');
    expect(s3.entries['login__input--email'].source).toBe('manual');
  });

  it('records source "sticky" for a draft taken from an existing id', async () => {
    const storage = new InMemoryStorage();
    const stickyNode = () => node({ tag: 'input', signals: { form_control: 'email' }, existingId: 'login__input--email' });
    const { snapshot: s } = await reconcile(draftsFor(stickyNode()), storage, NOW);
    expect(s.entries['login__input--email'].source).toBe('sticky');
  });

  it('makes diff report a comeback as regenerated, not added', async () => {
    const storage = new InMemoryStorage();
    await reconcile(draftsFor(emailInput(), button()), storage, NOW); // v1: both
    await reconcile(draftsFor(button()), storage, NOW);               // v2: email gone
    await reconcile(draftsFor(emailInput(), button()), storage, NOW); // v3: email back

    const v2 = await storage.loadVersion(2);
    const v3 = await storage.loadVersion(3);
    const d = diff(v2!, v3!);
    expect(d.summary.regenerated).toBe(1);
    expect(d.summary.added).toBe(0);
    expect(d.regenerated.map((r) => r.id)).toContain('login__input--email');
  });

  it('persists the draft disambiguator on the entry', async () => {
    const storage = new InMemoryStorage();
    const two = [
      node({ tag: 'button', signals: { event_handlers: { click: 'save' }, text: 'Save' } }),
      node({ tag: 'button', signals: { event_handlers: { click: 'save' }, text: 'Submit' } }),
    ];
    const { snapshot: s } = await reconcile(draftsFor(...two), storage, NOW);
    const entries = Object.values(s.entries);
    expect(entries.map((e) => e.disambiguator).sort()).toEqual(['', '2']);
  });
});

describe('scoped reconcile (partial tag runs must not mass-retire)', () => {
  const fileNode = (file: string, formControl: string) =>
    node({ tag: 'input', signals: { form_control: formControl }, loc: { file, start: 0, end: 1 }, component: formControl });

  it('an entry whose file is OUT of this run scope is carried forward, not retired', async () => {
    const storage = new InMemoryStorage();
    await reconcile(draftsFor(fileNode('a.vue', 'email'), fileNode('b.vue', 'phone')), storage, NOW, {
      scopeFiles: new Set(['a.vue', 'b.vue']),
    });
    // Partial run: only a.vue tagged again.
    const { snapshot: s2 } = await reconcile(draftsFor(fileNode('a.vue', 'email')), storage, NOW, {
      scopeFiles: new Set(['a.vue']),
    });
    expect(s2.entries['phone__input--phone']).toBeDefined();
    expect(s2.retired['phone__input--phone']).toBeUndefined();
    const d = diff((await storage.loadVersion(1))!, s2);
    expect(d.removed).toHaveLength(0);
  });

  it('an entry whose file IS in scope and whose element is gone still retires', async () => {
    const storage = new InMemoryStorage();
    await reconcile(draftsFor(fileNode('a.vue', 'email'), fileNode('a.vue', 'phone')), storage, NOW, {
      scopeFiles: new Set(['a.vue']),
    });
    const { snapshot: s2 } = await reconcile(draftsFor(fileNode('a.vue', 'email')), storage, NOW, {
      scopeFiles: new Set(['a.vue']),
    });
    expect(s2.entries['phone__input--phone']).toBeUndefined();
    expect(s2.retired['phone__input--phone']).toBeDefined();
  });

  it('reports how many entries were carried as out-of-scope', async () => {
    const storage = new InMemoryStorage();
    await reconcile(draftsFor(fileNode('a.vue', 'email'), fileNode('b.vue', 'phone')), storage, NOW, {
      scopeFiles: new Set(['a.vue', 'b.vue']),
    });
    const { outOfScope } = await reconcile(draftsFor(fileNode('a.vue', 'email')), storage, NOW, {
      scopeFiles: new Set(['a.vue']),
    });
    expect(outOfScope).toBe(1);
  });

  it('legacy entries without a recorded file keep the old retire-on-absence behavior', async () => {
    const storage = new InMemoryStorage();
    // Simulate a pre-upgrade registry: entry without `file`.
    await storage.save(snapshot(1, { 'legacy__input--x': entry({ fingerprint: 'f', identity: 'legacy::input::x' }) }));
    const { snapshot: s2, outOfScope } = await reconcile(draftsFor(fileNode('a.vue', 'email')), storage, NOW, {
      scopeFiles: new Set(['a.vue']),
    });
    expect(s2.retired['legacy__input--x']).toBeDefined();
    expect(outOfScope).toBe(0);
  });

  it('a carried-forward entry re-tagged later is NOT misclassified as regenerated', async () => {
    const storage = new InMemoryStorage();
    await reconcile(draftsFor(fileNode('a.vue', 'email'), fileNode('b.vue', 'phone')), storage, NOW, {
      scopeFiles: new Set(['a.vue', 'b.vue']),
    });
    await reconcile(draftsFor(fileNode('a.vue', 'email')), storage, NOW, { scopeFiles: new Set(['a.vue']) });
    const { snapshot: s3 } = await reconcile(draftsFor(fileNode('a.vue', 'email'), fileNode('b.vue', 'phone')), storage, NOW, {
      scopeFiles: new Set(['a.vue', 'b.vue']),
    });
    expect(s3.entries['phone__input--phone'].generation_history).toEqual([1]);
    const d = diff((await storage.loadVersion(2))!, s3);
    expect(d.regenerated).toHaveLength(0);
  });
});
