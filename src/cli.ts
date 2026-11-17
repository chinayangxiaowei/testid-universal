#!/usr/bin/env node
/**
 * testid — the convenient entry point.
 *
 * By default it runs FULLY EMBEDDED: no server to start, registry persisted as
 * JSON files (just like the original tool). Add `--server <url>` and the exact
 * same commands run against a remote backend instead. Nothing else changes.
 *
 *   testid tag <paths...> [--ext .html|.vue|.jsx,.tsx] [--adapter html|vue|angular|react] [--attr data-testid]
 *              [--registry DIR] [--server URL] [--regenerate] [--dry] [--check] [--no-deps]
 *   testid diff <fromVersion> <toVersion> [--registry DIR] [--server URL]
 *   testid gen-locators [--target robot|playwright|cypress|webdriverio|selenium-python|testcafe] [--out DIR] [--registry DIR] [--server URL]
 *   testid gen-constants [--out FILE] [--lang ts|js] [--check] [--registry DIR] [--server URL]
 *   testid affected <fromVersion> <toVersion> | --since FILE  [--tests DIR[,DIR]] [--out-list FILE] [--include-limited] [--grep-out FILE] [--files-only] [--registry DIR] [--server URL]
 *   testid mark-green [--since FILE] [--registry DIR] [--server URL]   (record latest version as the re-test anchor)
 *
 * The adapter is picked from the matched files (.vue -> VueAdapter, else HTML);
 * --adapter overrides. Mixed .vue/non-.vue runs must be split (or use --adapter).
 * `tag --check` is the CI gate: writes nothing, exits 1 if tagging is required.
 */
import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createTransport, LocalTransport } from './client/transport';
import { runPipeline, formatWarning } from './client/pipeline';
import { FrameworkAdapter } from './adapters/contract';
import { HtmlTemplateAdapter } from './adapters/html';
import { VueAdapter } from './adapters/vue';
import { AngularAdapter } from './adapters/angular';
import { ReactAdapter } from './adapters/react';
import { diffToMarkdown } from './registry/diff';
import { InMemoryStorage } from './registry/storage';
import { LocatorTarget, generateConstants, constantsLangForPath, ConstantsLang } from './locators';
import { buildTestMap, buildTestMapForIds, affectedTests, affectedTestsToMarkdown, buildTestCaseMapForIds, affectedTestCases, affectedTestCasesToMarkdown, coverageReport, coverageToMarkdown, depthLimitedTests, depthLimitedToMarkdown, retestFiles } from './testmap';
import { readRuntimeRecord } from './runtime';

/** Switches that never take a value — they must not swallow a following positional. */
const BOOLEAN_FLAGS = new Set(['check', 'dry', 'regenerate', 'no-deps', 'files-only', 'include-limited']);

export function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function walk(paths: string[], exts: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const child of readdirSync(p)) out.push(...walk([join(p, child)], exts));
    } else if (exts.includes(extname(p))) out.push(p);
  }
  return out;
}

function componentOf(file: string): string {
  return basename(file).replace(/\.[^.]+$/, '').replace(/\.component$/, '');
}

async function cmdTag(positional: string[], flags: Record<string, string | boolean>) {
  const registryDir = (flags.registry as string) ?? 'test-artifacts/testids';
  const transport = createTransport({ server: flags.server as string, registryDir });
  const exts = ((flags.ext as string) ?? '.html').split(',');
  const paths = walk(positional, exts);
  if (paths.length === 0) { console.error('no matching files'); process.exit(2); }

  const files = paths.map((file) => ({
    file, component: componentOf(file), source: readFileSync(file, 'utf8'),
  }));

  // Pick the adapter from the matched file set; --adapter overrides. Angular templates
  // are .html too, so they are detected by content (markers that valid plain HTML
  // cannot contain: (event)= / [prop]= / *ngIf / @if( / Angular vocabulary).
  const ANGULAR_MARKERS = /\(\w+\)=|\[[\w.()-]+\]=|\*ng(If|For|Switch)|@(if|for|switch|defer)\s*\(|formControlName|routerLink|<ng-(container|template)/;
  const vueCount = paths.filter((p) => p.endsWith('.vue')).length;
  const reactCount = paths.filter((p) => /\.(jsx|tsx)$/.test(p)).length;
  const auto = vueCount === paths.length ? 'vue'
    : reactCount === paths.length ? 'react'
    : vueCount > 0 || reactCount > 0 ? 'mixed'
    : files.some((f) => ANGULAR_MARKERS.test(f.source)) ? 'angular' : 'html';
  const choice = (flags.adapter as string) ?? auto;
  if (!['vue', 'html', 'angular', 'react'].includes(choice)) {
    console.error(choice === 'mixed'
      ? 'mixed framework extensions matched; run them separately or pass --adapter <html|vue|angular|react>'
      : `unknown adapter "${choice}" (expected html, vue, angular or react)`);
    process.exit(2);
  }
  const adapter: FrameworkAdapter = choice === 'vue' ? new VueAdapter()
    : choice === 'angular' ? new AngularAdapter()
    : choice === 'react' ? new ReactAdapter() : new HtmlTemplateAdapter();

  const config = flags.attr ? { attributeName: flags.attr as string } : undefined;

  if (flags.check) {
    // CI mode: tag against a throwaway in-memory registry — writes neither source
    // files nor a registry version. Sticky ids make this exact: an already-tagged
    // file re-serializes byte-identically, so any difference = untagged elements.
    const checkTransport = new LocalTransport(new InMemoryStorage());
    // Dep tracking only feeds the registry; the check compares written source only.
    const checked = await runPipeline(adapter, checkTransport, files, config, { deps: false });
    if (checked.warnings.length) {
      console.warn(`${checked.warnings.length} identity warning(s):`);
      for (const w of checked.warnings) console.warn(`  - ${formatWarning(w)}`);
    }
    const changed = checked.tagged.filter((t) => t.after !== t.before).map((t) => t.file);
    if (changed.length) {
      console.error(`tagging required for ${changed.length} file(s):`);
      for (const f of changed) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log('tagging up to date');
    return;
  }

  const result = await runPipeline(adapter, transport, files, config, { regenerate: !!flags.regenerate, deps: !flags['no-deps'] });

  for (const t of result.tagged) {
    if (flags.dry) { console.log(`--- ${t.file} (dry) ---\n${t.after}\n`); }
    else if (t.after !== t.before) { writeFileSync(t.file, t.after); console.log(`tagged ${t.file}`); }
  }
  console.log(`registry version ${result.version}${flags.server ? ` (remote ${flags.server})` : ` (${registryDir})`}`);
  if (result.overrides.length) console.log(`manual overrides: ${result.overrides.join(', ')}`);
  if (result.warnings.length) {
    console.warn(`\n${result.warnings.length} identity warning(s):`);
    for (const w of result.warnings) console.warn(`  - ${formatWarning(w)}`);
  }
  const st = result.stats;
  console.log(`tagging coverage: ${st.tagged}/${st.elements} parsed elements tagged` +
    ` (${st.skipped_no_signal} no-signal, ${st.skipped_policy} policy-skipped)`);
  // Layer-2 dep tracking report — never silent: off, and unresolved imports, are stated.
  if (!result.deps.enabled) {
    console.log(flags['no-deps'] ? 'dep tracking: OFF (--no-deps) -- only directly referenced definitions are tracked'
      : `dep tracking: not supported by the ${adapter.name} adapter`);
  } else {
    console.log(`dep tracking: ${result.deps.tracked} one-hop definition(s) tracked`);
    if (result.deps.unresolved.length) {
      console.warn(`dep tracking: ${result.deps.unresolved.length} local import(s) UNRESOLVED -- changes there will NOT trigger re-tests:`);
      for (const u of result.deps.unresolved) console.warn(`  - ${u}`);
    }
    if (result.deps.limited.length) {
      // Honest boundary: layer 3+ and dynamic dispatch are named, never silently green.
      const shown = result.deps.limited.slice(0, 10);
      console.warn(`dep tracking: ${result.deps.limited.length} dependenc(ies) BEYOND tracking depth (layer 3+ / dynamic) -- changes there will NOT trigger re-tests; \`affected\` lists the tests to fall back to:`);
      for (const l of shown) console.warn(`  - ${l}`);
      if (result.deps.limited.length > shown.length) console.warn(`  ... ${result.deps.limited.length - shown.length} more (see dep_limited in the registry)`);
    }
  }
  if (result.outOfScope > 0) {
    console.log(`note: partial run -- ${result.outOfScope} registry entr(ies) from files outside this run carried forward, not retired`);
  }
}

async function cmdDiff(positional: string[], flags: Record<string, string | boolean>) {
  const transport = createTransport({ server: flags.server as string, registryDir: (flags.registry as string) ?? 'test-artifacts/testids' });
  const from = Number(positional[0]), to = Number(positional[1]);
  const d = await transport.diff(from, to, Number(flags.threshold ?? 0.8));
  if (!d) { console.error('versions not found'); process.exit(2); }
  console.log(diffToMarkdown(d));
}

async function cmdGenLocators(flags: Record<string, string | boolean>) {
  const transport = createTransport({ server: flags.server as string, registryDir: (flags.registry as string) ?? 'test-artifacts/testids' });
  const target = ((flags.target as string) ?? 'robot') as LocatorTarget;
  const files = await transport.locators(target, flags.attr as string);
  if (!files) { console.error('no registry yet'); process.exit(2); }
  const outDir = (flags.out as string) ?? 'tests/locators';
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outDir, name), content);
    console.log(`wrote ${join(outDir, name)}`);
  }
}

async function cmdGenConstants(flags: Record<string, string | boolean>) {
  const transport = createTransport({ server: flags.server as string, registryDir: (flags.registry as string) ?? 'test-artifacts/testids' });
  const snap = await transport.latest();
  if (!snap) { console.error('no registry yet'); process.exit(2); }
  const lang = (flags.lang as string | undefined) ?? constantsLangForPath(flags.out as string);
  if (lang !== 'ts' && lang !== 'js') { console.error(`--lang must be ts or js (got ${lang})`); process.exit(2); }
  const out = generateConstants(snap, { lang: lang as ConstantsLang });
  if (flags.check) {
    // CI gate: writes nothing; exit 1 when the committed constants module is
    // missing or stale relative to the latest registry version.
    const target = flags.out as string;
    if (!target) { console.error('--check requires --out <file> (the committed constants module)'); process.exit(2); }
    let current: string | null = null;
    try { current = readFileSync(target, 'utf8'); } catch { /* missing */ }
    if (current === out) { console.log(`constants up to date (${target}, registry v${snap.version})`); return; }
    console.error(current == null
      ? `constants module missing: ${target} -- run gen-constants`
      : `constants module stale: ${target} does not match registry v${snap.version} -- re-run gen-constants and commit`);
    process.exit(1);
  }
  if (flags.out) {
    writeFileSync(flags.out as string, out);
    console.log(`wrote ${flags.out}`);
  } else {
    process.stdout.write(out);
  }
}

function loadTestFiles(flags: Record<string, string | boolean>): { file: string; source: string }[] {
  const testDirs = ((flags.tests as string) ?? 'e2e').split(',');
  return walk(testDirs, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
    // The generated constants module contains every raw id by construction; scanning
    // it would put it in every report. It is an artifact, not a test.
    .filter((f) => !f.source.startsWith('// Auto-generated testid constants'));
}

async function cmdCoverage(flags: Record<string, string | boolean>) {
  const transport = createTransport({ server: flags.server as string, registryDir: (flags.registry as string) ?? 'test-artifacts/testids' });
  const snap = await transport.latest();
  if (!snap) { console.error('no registry yet'); process.exit(2); }
  const exercised = flags.runtime ? readRuntimeRecord(flags.runtime as string) : undefined;
  const report = coverageReport(snap, buildTestMap(loadTestFiles(flags), snap), exercised);
  console.log(coverageToMarkdown(report));
  if (flags.min !== undefined) {
    const min = Number(flags.min);
    const pct = report.interactive.ratio * 100;
    if (pct < min) {
      console.error(`interactive coverage ${pct.toFixed(1)}% is below --min ${min}`);
      process.exit(1);
    }
  }
}

function readSinceFile(path: string): { version: number } | null {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

async function cmdAffected(positional: string[], flags: Record<string, string | boolean>) {
  const transport = createTransport({ server: flags.server as string, registryDir: (flags.registry as string) ?? 'test-artifacts/testids' });
  let from = Number(positional[0]), to = Number(positional[1]);
  if (flags.since) {
    // State-anchored mode: diff from the last green version to the latest.
    const state = readSinceFile(flags.since as string);
    if (!state || typeof state.version !== 'number') {
      console.error(`no usable since-file at ${flags.since} -- create it with: testid mark-green --since ${flags.since}`);
      process.exit(2);
    }
    const latest = await transport.latest();
    if (!latest) { console.error('no registry yet'); process.exit(2); }
    from = state.version;
    to = latest.version;
    if (from === to) { console.log(`nothing new: registry is still at v${from} (last green)`); return; }
    console.log(`affected since last green: v${from} -> v${to}`);
  }
  const d = await transport.diff(from, to);
  if (!d) { console.error('versions not found'); process.exit(2); }

  const testFiles = loadTestFiles(flags);

  // The map must cover ids on BOTH sides of the diff (removed ids are absent from the
  // `to` snapshot), so it is built from the diff's own id set — works over any transport.
  const ids = [...d.added, ...d.removed, ...d.modified, ...d.regenerated].map((e) => e.id);
  // Case-level by default (names the exact test blocks); --files-only keeps the
  // older file-level report.
  const limited = await loadDepthLimited(transport, testFiles);
  const md = depthLimitedToMarkdown(limited);
  const fallback = flags['include-limited'] ? limited : [];
  if (flags['files-only']) {
    const affected = affectedTests(d, buildTestMapForIds(testFiles, ids));
    console.log(affectedTestsToMarkdown(affected));
    if (md) console.log(md);
    if (flags['out-list']) writeOutList(flags, retestFiles(affected, fallback), fallback.length);
    return;
  }
  const affected = affectedTestCases(d, buildTestCaseMapForIds(testFiles, ids));
  console.log(affectedTestCasesToMarkdown(affected));
  if (md) console.log(md);
  // Runners select by FILE, so the list stays file-level (the case detail is in
  // the printed report and, with --grep-out, as a title alternation).
  if (flags['out-list']) writeOutList(flags, retestFiles(affected, fallback), fallback.length);
  if (flags['grep-out']) {
    // A title alternation for `playwright test -g` / `vitest -t` selective runs.
    const titles = [...new Set(affected.filter((a) => a.action === 're-test').flatMap((a) => a.tests.map((t) => t.test).filter(Boolean)))].sort();
    writeFileSync(flags['grep-out'] as string, titles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + (titles.length ? '\n' : ''));
    console.log(`wrote ${flags['grep-out']} (${titles.length} test title(s) for -g/-t)`);
  }
}

/** Beyond-depth fallback list: tests whose elements depend on untracked code. */
async function loadDepthLimited(transport: ReturnType<typeof createTransport>, testFiles: { file: string; source: string }[]) {
  const latest = await transport.latest();
  if (!latest) return [];
  const ids = Object.keys(latest.entries).filter((id) => latest.entries[id].dep_limited?.length);
  return ids.length ? depthLimitedTests(latest, buildTestMapForIds(testFiles, ids)) : [];
}

function writeOutList(flags: Record<string, string | boolean>, files: string[], fallback: number) {
  writeFileSync(flags['out-list'] as string, files.join('\n') + (files.length ? '\n' : ''));
  console.log(`wrote ${flags['out-list']} (${files.length} test file(s) to re-run` +
    (flags['include-limited'] ? `, incl. beyond-depth fallback from ${fallback} id(s))` : ')'));
}

async function cmdMarkGreen(flags: Record<string, string | boolean>) {
  const transport = createTransport({ server: flags.server as string, registryDir: (flags.registry as string) ?? 'test-artifacts/testids' });
  const sinceFile = (flags.since as string) ?? '.testids-green.json';
  const latest = await transport.latest();
  if (!latest) { console.error('no registry yet'); process.exit(2); }
  writeFileSync(sinceFile, JSON.stringify({ version: latest.version, marked_at: new Date().toISOString() }, null, 2) + '\n');
  console.log(`marked v${latest.version} as green (${sinceFile})`);
}

async function cmdRollback(flags: Record<string, string | boolean>) {
  const transport = createTransport({ server: flags.server as string, registryDir: (flags.registry as string) ?? 'test-artifacts/testids' });
  if (!transport.rollback) { console.error('rollback is embedded-only (not available over --server)'); process.exit(2); }
  const r = await transport.rollback();
  if (!r) { console.error('nothing to roll back (registry is at v1 or empty)'); process.exit(1); }
  console.log(`rolled back: latest is now v${r.to} (was v${r.from}; v${r.from} is kept and a re-tag overwrites it)`);
}

async function cmdActivity(flags: Record<string, string | boolean>) {
  const transport = createTransport({ server: flags.server as string, registryDir: (flags.registry as string) ?? 'test-artifacts/testids' });
  if (!transport.activity) { console.error('activity is embedded-only (not available over --server)'); process.exit(2); }
  const log = await transport.activity();
  if (!log.length) { console.log('(no activity recorded)'); return; }
  for (const e of log) {
    console.log(e.action === 'save'
      ? `${e.at}  save      v${e.version}`
      : `${e.at}  rollback  v${e.from} -> v${e.to}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case 'tag': return cmdTag(positional, flags);
    case 'diff': return cmdDiff(positional, flags);
    case 'gen-locators': return cmdGenLocators(flags);
    case 'gen-constants': return cmdGenConstants(flags);
    case 'affected': return cmdAffected(positional, flags);
    case 'coverage': return cmdCoverage(flags);
    case 'mark-green': return cmdMarkGreen(flags);
    case 'rollback': return cmdRollback(flags);
    case 'activity': return cmdActivity(flags);
    default:
      console.log('usage: testid <tag|diff|gen-locators|gen-constants|affected|coverage|mark-green|rollback|activity> [...]  (add --server <url> to use a remote backend)');
      process.exit(cmd ? 2 : 0);
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
