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
});
