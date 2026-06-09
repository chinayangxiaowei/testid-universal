import { ElementNode } from '../src/core/types';
import { RegistryEntry, RegistrySnapshot } from '../src/registry/storage';
import { normalizeSignals } from '../src/core/signals';

/** Build an ElementNode with sensible defaults; override what a test cares about. */
export function node(partial: Partial<ElementNode> & { tag: string }): ElementNode {
  return { component: 'login', signals: {}, ...partial };
}

/** Build a RegistryEntry; only `fingerprint` and `component` really matter for diff tests. */
export function entry(partial: Partial<RegistryEntry> & { fingerprint: string }): RegistryEntry {
  return {
    component: 'login',
    tag: 'input',
    element_type: 'native_input_text',
    identity: 'login::input::x',
    signals: normalizeSignals({}),
    source: 'generated',
    first_seen_version: 1,
    last_seen_version: 1,
    last_generated_at: '2026-01-01T00:00:00.000Z',
    generation_history: [1],
    ...partial,
  };
}

/** Build a RegistrySnapshot from a map of id -> entry. */
export function snapshot(version: number, entries: Record<string, RegistryEntry>): RegistrySnapshot {
  return { version, generated_at: '2026-01-01T00:00:00.000Z', entries };
}
