import { describe, it, expect } from 'vitest';
import { ReactAdapter } from '../../src/adapters/react';
import { VueAdapter } from '../../src/adapters/vue';
import { AngularAdapter } from '../../src/adapters/angular';
import { HtmlTemplateAdapter } from '../../src/adapters/html';
import { FrameworkAdapter } from '../../src/adapters/contract';

// Re-tagging must replace a tag's OWN existing testid, never add a second one. The
// fuzz test found `href={/* { */ x}`: the text lexer counted the `{` inside a comment
// and stopped seeing the top-level attribute -> duplicate data-testid. AST adapters now
// hand the exact ranges of the tag's own testid attributes to the writer (loc.strip);
// only the HTML adapter still relies on the lexer.
const retag = (a: FrameworkAdapter, src: string, file: string) =>
  a.write(src, a.parse(src, file, 'C').map((n, i) => ({ loc: n.loc!, attributeName: 'data-testid', id: `new-${i}` })));
const count = (s: string) => (s.match(/data-testid=/g) ?? []).length;

const cases: { name: string; adapter: () => FrameworkAdapter; file: string; src: string; ids: number }[] = [
  { name: 'React: `{` inside a block comment in an expression (fuzz seed 20261124)', adapter: () => new ReactAdapter(), file: 'A.jsx',
    src: `const A = () => <a href={/* { */ x} data-testid="old" />;\n`, ids: 1 },
  { name: 'React: `}` inside a line comment', adapter: () => new ReactAdapter(), file: 'A.jsx',
    src: `const A = () => <a onClick={() => { // }\n go(); }} data-testid="old" />;\n`, ids: 1 },
  { name: 'React: escaped quote inside a string literal', adapter: () => new ReactAdapter(), file: 'A.jsx',
    src: `const A = () => <a title={"\\"}"} data-testid="old" />;\n`, ids: 1 },
  { name: 'React: brace inside a template-literal substitution', adapter: () => new ReactAdapter(), file: 'A.jsx',
    src: 'const A = () => <a title={`${"}"}`} data-testid="old" />;\n', ids: 1 },
  { name: 'React: single-quoted existing testid', adapter: () => new ReactAdapter(), file: 'A.jsx',
    src: `const A = () => <a href="/x" data-testid='old' />;\n`, ids: 1 },
  { name: 'React: nested element with its own id inside a prop keeps it', adapter: () => new ReactAdapter(), file: 'A.jsx',
    src: `const A = () => <Chat t={/* { */ <T data-testid="inner" />} data-testid="outer" />;\n`, ids: 2 },
  { name: 'Vue: single-quoted existing testid', adapter: () => new VueAdapter(), file: 'A.vue',
    src: `<template>\n  <button @click="go('}')" data-testid='old'>Go</button>\n</template>\n`, ids: 1 },
  { name: 'Angular: single-quoted existing testid', adapter: () => new AngularAdapter(), file: 'a.component.html',
    src: `<button (click)="go('}')" data-testid='old'>Go</button>\n`, ids: 1 },
  { name: 'HTML: single-quoted existing testid', adapter: () => new HtmlTemplateAdapter(), file: 'a.html',
    src: `<button title="a > b" data-testid='old'>Go</button>\n`, ids: 1 },
];

describe('write-back replaces the tag\'s own testid (no duplicates)', () => {
  for (const c of cases) {
    it(c.name, () => {
      const out = retag(c.adapter(), c.src, c.file);
      expect(count(out)).toBe(c.ids);
      expect(out).not.toContain('old');
      expect(retag(c.adapter(), out, c.file)).toBe(out);
    });
  }
});
