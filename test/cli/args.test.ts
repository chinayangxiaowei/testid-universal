import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/cli';

// A boolean switch must never swallow the positional that follows it:
// `testid tag --check src` used to read as { check: 'src' } -> "no matching files".
describe('parseArgs', () => {
  it('boolean switches do not consume the next positional', () => {
    expect(parseArgs(['--check', 'src', '--ext', '.vue'])).toEqual({ positional: ['src'], flags: { check: true, ext: '.vue' } });
    expect(parseArgs(['--include-limited', '--files-only', '3', '4'])).toEqual({ positional: ['3', '4'], flags: { 'include-limited': true, 'files-only': true } });
    for (const f of ['dry', 'regenerate', 'no-deps']) expect(parseArgs([`--${f}`, 'src']).positional).toEqual(['src']);
  });

  it('value flags still take their value', () => {
    expect(parseArgs(['src', '--registry', '.testids', '--check'])).toEqual({ positional: ['src'], flags: { registry: '.testids', check: true } });
  });
});
