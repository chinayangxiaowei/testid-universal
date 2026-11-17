import { describe, it, expect } from 'vitest';
import { ReactAdapter } from '../../src/adapters/react';
import { VueAdapter } from '../../src/adapters/vue';
import { HtmlTemplateAdapter } from '../../src/adapters/html';
import { FrameworkAdapter } from '../../src/adapters/contract';

// Minimal-invasion contract for write-back: tagging inserts ` data-testid="…"` and
// changes NOTHING else (no whitespace/newline/self-close reformatting), and a re-tag
// is byte-identical. Regression for the downstream report: a multi-line opening tag
// lost the newline+indent before its `/>` (most visibly after a nested JSX hole).
const strip = (s: string) => s.replace(/ data-testid="[^"]*"/g, '');
const tagAll = (a: FrameworkAdapter, src: string, file: string) =>
  a.write(src, a.parse(src, file, 'C').map((n, i) => ({ loc: n.loc!, attributeName: 'data-testid', id: `c__${n.tag}--${i}` })));

const cases: { name: string; adapter: () => FrameworkAdapter; file: string; src: string }[] = [
  {
    name: 'React: multi-line ternary with a nested hole before the closing />',
    adapter: () => new ReactAdapter(), file: 'A.jsx',
    src: `const A = () => (
  <Chat
    terminal={cond
      ? <Terminal onClose={close} />
      : null}
  />
);
`,
  },
  {
    name: 'React: prettier multi-line props, /> on its own line',
    adapter: () => new ReactAdapter(), file: 'B.jsx',
    src: `const B = () => (
  <button
    type="submit"
    onClick={save}
  >
    Save
  </button>
);
`,
  },
  {
    name: 'React: compact self-closing <Icon/> keeps its form',
    adapter: () => new ReactAdapter(), file: 'C.jsx',
    src: `const C = () => <Icon onClick={go}/>;\n`,
  },
  {
    name: 'Vue: multi-line opening tag, > on its own line',
    adapter: () => new VueAdapter(), file: 'D.vue',
    src: `<template>
  <button
    type="submit"
    @click="save"
  >Save</button>
</template>
`,
  },
  {
    name: 'HTML: multi-line opening tag and compact self-close',
    adapter: () => new HtmlTemplateAdapter(), file: 'e.html',
    src: `<form>
  <input
    name="email"
  />
  <input name="pw"/>
</form>`,
  },
];

describe('write-back preserves source formatting', () => {
  for (const c of cases) {
    it(c.name, () => {
      const once = tagAll(c.adapter(), c.src, c.file);
      expect(once).not.toBe(c.src);
      expect(strip(once)).toBe(c.src);
      expect(tagAll(c.adapter(), once, c.file)).toBe(once);
    });
  }

  it('already-tagged source written by the previous format stays byte-identical (no churn)', () => {
    const src = `const A = () => <Icon onClick={go} data-testid="c__Icon--0" />;\n`;
    expect(tagAll(new ReactAdapter(), src, 'A.jsx')).toBe(src);
  });
});
