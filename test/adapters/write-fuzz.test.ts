import { describe, it, expect } from 'vitest';
import { parse as babelParse } from '@babel/parser';
import { runPipeline } from '../../src/client/pipeline';
import { LocalTransport } from '../../src/client/transport';
import { InMemoryStorage } from '../../src/registry/storage';
import { ReactAdapter } from '../../src/adapters/react';

// Property-based guard for the write-back surgery (downstream request): hand-written
// cases only cover shapes someone thought of. For random, VALID JSX — nesting, JSX in
// props, ternaries, spreads, template literals, strings and comments full of quotes and
// braces, arbitrary attribute layout — three invariants must hold:
//
//   1. the written file still parses;
//   2. removing every inserted ` data-testid="…"` restores the source byte-for-byte
//      (the write touches nothing else);
//   3. re-tagging the written file is a fixed point (no churn).
//
// Deterministic: a seeded PRNG, so a failure is reproducible from the printed seed.
// FUZZ_N / FUZZ_SEED widen or pin the run locally.

const N = Number(process.env.FUZZ_N ?? 250);
const SEED0 = Number(process.env.FUZZ_SEED ?? 20261117);

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)];
  const chance = (p: number) => next() < p;
  return { int, pick, chance };
}
type R = ReturnType<typeof rng>;

const TAGS = ['div', 'button', 'input', 'span', 'form', 'a', 'select', 'textarea', 'li', 'Card', 'Foo.Bar'] as const;
const NASTY = [`a'b`, `{x}`, `}`, `{`, `a > b`, `<i>`, `it's {ok}`, `\\`, `/>`, `"`, '`', '${x}', `'}"`];

/** Whitespace between attributes: spaces, newlines with indentation, tabs. */
const ws = (r: R) => r.pick([' ', ' ', '\n    ', '\n      ', '\t', '  ']);

function strLit(r: R, q: '"' | "'"): string {
  const body = Array.from({ length: r.int(3) }, () => r.pick(NASTY)).join(r.pick(['', ' ']));
  return q + body.replace(/\\/g, '\\\\').split(q).join('\\' + q).replace(/\n/g, '\\n') + q;
}

function jsxAttrString(r: R): string {
  // JSX attribute strings have no escapes: just avoid the delimiter.
  const q = r.pick(['"', "'"] as const);
  const body = Array.from({ length: r.int(3) }, () => r.pick(NASTY)).join(' ').split(q).join('');
  return q + body + q;
}

function expr(r: R, depth: number): string {
  const opts: (() => string)[] = [
    () => r.pick(['a', 'props.x', 'state.items.length', '0', 'true', 'null']),
    () => strLit(r, r.pick(['"', "'"] as const)),
    () => '`t-${' + expr(r, depth + 1) + '}-' + r.pick(['}', '{', "'", '"', '']) + '`',
    () => `() => go(${strLit(r, '"')})`,
    () => `(e) => { e.preventDefault(); save({ a: 1, b: ${strLit(r, "'")} }); }`,
    () => `{ a: ${expr(r, depth + 1)}, 'b}': [1, 2] }`,
    () => `${expr(r, depth + 1)} ? ${expr(r, depth + 1)} : ${expr(r, depth + 1)}`,
    () => `/* c'{ */ ${expr(r, depth + 1)}`,
  ];
  if (depth < 3) {
    opts.push(() => element(r, depth + 1)); // JSX inside an expression / prop
    opts.push(() => `cond && ${element(r, depth + 1)}`);
    opts.push(() => `items.map((it) => ${element(r, depth + 1)})`);
  }
  return depth > 4 ? 'x' : r.pick(opts)();
}

let preId = 0;
function attr(r: R, depth: number): string {
  // A pre-existing own testid (sticky path), either quote style.
  if (r.chance(0.12)) return r.chance(0.5) ? `data-testid="pre-${preId++}"` : `data-testid='pre-${preId++}'`;
  const name = r.pick(['className', 'id', 'name', 'onClick', 'onChange', 'value', 'title', 'aria-label', 'style', 'render', 'href', 'disabled']);
  const shape = r.int(5);
  if (shape === 0) return name; // boolean attribute
  if (shape === 1) return `${name}=${jsxAttrString(r)}`;
  if (shape === 2) return `{...${r.pick(['props', 'rest', '(cond ? a : b)'])}}`;
  return `${name}=${r.pick(['', ' '])}{${expr(r, depth)}}`.replace('= {', '={'); // JSX forbids space after =? keep tight
}

function child(r: R, depth: number): string {
  const opts: (() => string)[] = [
    () => r.pick(['hello', "it's", 'a &amp; b', 'x', '"quoted"', '  spaced  ']),
    () => `{${expr(r, depth + 1)}}`,
    () => `{/* ${r.pick(['}', '{', "'", '"', '<b>'])} */}`,
    () => `{${strLit(r, '"')}}`,
  ];
  if (depth < 4) {
    opts.push(() => element(r, depth + 1));
    opts.push(() => element(r, depth + 1));
    opts.push(() => `<>${child(r, depth + 1)}</>`);
  }
  return r.pick(opts)();
}

function element(r: R, depth: number): string {
  const tag = r.pick(TAGS);
  const attrs = Array.from({ length: r.int(4) }, () => attr(r, depth));
  const open = `<${tag}${attrs.map((a) => ws(r) + a).join('')}${r.chance(0.3) ? ws(r) : ''}`;
  if (depth > 3 || r.chance(0.35)) return `${open}${r.pick(['/>', ' />', '\n  />'])}`;
  const kids = Array.from({ length: r.int(4) }, () => child(r, depth)).join(r.pick(['', '\n', ' ']));
  return `${open}>${kids}</${tag}>`;
}

function program(r: R): string {
  const root = element(r, 0);
  return [
    "import { Card, Foo } from './ui';",
    'export default function Page(props) {',
    "  const { a, cond, items, state, rest, go, save, x, b } = props;",
    `  return (\n    ${root}\n  );`,
    '}',
    '',
  ].join('\n');
}

const parse = (code: string) => babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
const parses = (code: string) => {
  try {
    parse(code);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

/** Opening elements that carry more than one data-testid / data-cy attribute. */
function duplicateIds(code: string): string[] {
  const bad: string[] = [];
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n.type === 'JSXOpeningElement') {
      const own = (n.attributes ?? []).filter((a: any) => a.type === 'JSXAttribute' && /^(data-testid|data-cy)$/.test(a.name?.name));
      if (own.length > 1) bad.push(code.slice(n.start, n.end));
    }
    for (const k of Object.keys(n)) if (k !== 'loc' && typeof n[k] === 'object') visit(n[k]);
  };
  visit(parse(code).program);
  return bad;
}

const INSERTED = / data-testid="[a-z0-9_-]+"/g;

describe('write-back fuzz (React) — parse, byte-exact restore, idempotent', () => {
  it(`${N} random valid JSX programs keep all three invariants`, async () => {
    let generated = 0;
    let tagged = 0;
    for (let i = 0; i < N; i++) {
      const seed = SEED0 + i;
      const src = program(rng(seed));
      if (parses(src)) continue; // generator produced something babel rejects: not a write-back case
      generated++;
      const transport = new LocalTransport(new InMemoryStorage());
      const run = (source: string) => runPipeline(new ReactAdapter(), transport, [{ file: 'Page.jsx', component: 'Page', source }], undefined, { deps: false });
      let out: string;
      try {
        out = (await run(src)).tagged[0].after;
      } catch (e) {
        throw new Error(`seed ${seed}: write threw ${(e as Error).message}\n--- source ---\n${src}`);
      }
      if (out !== src) tagged++;
      const err = parses(out);
      if (err) throw new Error(`seed ${seed}: output does not parse: ${err}\n--- source ---\n${src}\n--- output ---\n${out}`);
      const dup = duplicateIds(out);
      if (dup.length) throw new Error(`seed ${seed}: element carries two testids: ${dup[0]}\n--- source ---\n${src}\n--- output ---\n${out}`);
      // Byte-exact restore applies when the source had no ids of its own (otherwise the
      // writer legitimately replaces them).
      const restored = src.includes('data-testid') ? src : out.replace(INSERTED, '');
      if (restored !== src) throw new Error(`seed ${seed}: removing inserted ids does not restore the source\n--- source ---\n${src}\n--- output ---\n${out}`);
      const again = (await run(out)).tagged[0].after;
      if (again !== out) throw new Error(`seed ${seed}: re-tag is not a fixed point\n--- first ---\n${out}\n--- second ---\n${again}`);
    }
    if (process.env.FUZZ_STATS) require('node:fs').writeFileSync(process.env.FUZZ_STATS, JSON.stringify({ N, generated, tagged }));
    // The generator must actually exercise the writer, not mostly emit rejects.
    expect(generated).toBeGreaterThan(N * 0.8);
    expect(tagged).toBeGreaterThan(generated * 0.5);
  }, 120_000);
});
