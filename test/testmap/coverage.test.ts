import { describe, it, expect } from 'vitest';
import { coverageReport, coverageToMarkdown } from '../../src/testmap';
import { snapshot, entry } from '../helpers';

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
