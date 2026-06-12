import { describe, it, expect } from 'vitest';
import { coverageReport, coverageToMarkdown } from '../../src/testmap';
import { snapshot, entry } from '../helpers';
import { normalizeSignals } from '../../src/core/signals';

const snap = snapshot(1, {
  'login__button--save': entry({ fingerprint: 'A', identity: 'l::button::save', element_type: 'native_button' }),
  'login__input--email': entry({ fingerprint: 'B', identity: 'l::input::email', element_type: 'native_input_email' }),
  'login__span--hint': entry({ fingerprint: 'C', identity: 'l::span::hint', element_type: 'element_span' }),
});
const map = { 'login__button--save': ['a.spec.ts'] };

describe('coverageReport', () => {
  it('computes overall and interactive coverage with an uncovered worklist', () => {
    const r = coverageReport(snap, map);
    expect(r.total).toBe(3);
    expect(r.covered).toBe(1);
    expect(r.interactive.total).toBe(2);  // button + input
    expect(r.interactive.covered).toBe(1);
    expect(r.uncovered.map((u) => u.id)).toEqual(['login__input--email', 'login__span--hint']); // interactive first
  });
});

describe('coverageToMarkdown', () => {
  it('renders ratios and the uncovered list', () => {
    const md = coverageToMarkdown(coverageReport(snap, map));
    expect(md).toContain('1/3');
    expect(md).toContain('1/2');
    expect(md).toContain('login__input--email');
  });
});

describe('interactive classification (semantics + ARIA role + tabindex)', () => {
  const snap2 = snapshot(1, {
    // The real Conduit case: <i role="button"> delete-comment icon.
    'c__i--emit': entry({ fingerprint: 'A', identity: 'c::i::emit', element_type: 'element_i', signals: normalizeSignals({ role: 'button' }) }),
    'c__div--focusable': entry({ fingerprint: 'B', identity: 'c::div::f', element_type: 'element_div', signals: normalizeSignals({ static_attributes: { tabindex: '0' } }) }),
    'c__div--unfocusable': entry({ fingerprint: 'C', identity: 'c::div::u', element_type: 'element_div', signals: normalizeSignals({ static_attributes: { tabindex: '-1' } }) }),
    'c__span--plain': entry({ fingerprint: 'D', identity: 'c::span::p', element_type: 'element_span' }),
  });

  it('counts ARIA-role and tabindex elements as interactive; plain spans not', () => {
    const r = coverageReport(snap2, {});
    expect(r.interactive.total).toBe(2); // role=button i + tabindex=0 div
    const flags = Object.fromEntries(r.uncovered.map((u) => [u.id, u.interactive]));
    expect(flags['c__i--emit']).toBe(true);
    expect(flags['c__div--focusable']).toBe(true);
    expect(flags['c__div--unfocusable']).toBe(false);
    expect(flags['c__span--plain']).toBe(false);
  });
});


describe('coverageReport with runtime exercised ids', () => {
  it('splits covered into exercised vs referenced-only, and surfaces unknown dynamic ids', () => {
    const r = coverageReport(snap, map, ['login__button--save', 'row-42']);
    expect(r.runtime).toEqual({
      exercised: 1,                                  // save button: referenced AND exercised
      referencedNotExercised: [],                    // nothing referenced-but-untouched
      unknownExercised: ['row-42'],                  // dynamic id outside the registry
    });
  });

  it('flags referenced-but-never-exercised ids', () => {
    const r = coverageReport(snap, map, ['row-1']);
    expect(r.runtime!.referencedNotExercised).toEqual(['login__button--save']);
  });
});

describe('isInteractive denominator (component-library reality)', () => {
  const entry = (over: any) => ({
    id: 'x', identity: 'x', component: 'c', element_type: over.element_type ?? 'element_div',
    signals: { event_handlers: {}, bound_identifiers: {}, static_attributes: {}, ...over.signals },
  }) as any;
  const snap = (entries: any[]) => ({ version: 1, generated_at: '', entries }) as any;

  it('an element with any event handler is interactive regardless of its tag name', () => {
    const r = coverageReport(snap([entry({ element_type: 'element_articlepreview', signals: { event_handlers: { click: 'pick' } } })]), {});
    expect(r.interactive.total).toBe(1);
  });

  it('a form-control binding (v-model on a custom component) is interactive', () => {
    const r = coverageReport(snap([entry({ element_type: 'element_my-date-picker', signals: { form_control: 'birthday' } })]), {});
    expect(r.interactive.total).toBe(1);
  });

  it('common component-library naming (btn/switch/radio/toggle/...) counts as interactive', () => {
    const types = ['vuetify_btn', 'element_q-btn', 'element_el-switch', 'element_el-radio', 'element_q-toggle', 'element_el-slider', 'element_el-date-picker'];
    const r = coverageReport(snap(types.map((t, i) => ({ ...entry({ element_type: t }), id: `x${i}`, identity: `x${i}` }))), {});
    expect(r.interactive.total).toBe(types.length);
  });

  it('"tab" matching must not swallow "table"', () => {
    const r = coverageReport(snap([entry({ element_type: 'element_table' })]), {});
    expect(r.interactive.total).toBe(0);
  });
});
