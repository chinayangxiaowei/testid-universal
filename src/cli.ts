#!/usr/bin/env node
/**
 * testid — the convenient entry point.
 *
 * By default it runs FULLY EMBEDDED: no server to start, registry persisted as
 * JSON files (just like the original tool). Add `--server <url>` and the exact
 * same commands run against a remote backend instead. Nothing else changes.
 *
 *   testid tag <paths...> [--ext .html|.vue|.jsx,.tsx] [--adapter html|vue|angular|react] [--attr data-testid]
 *              [--registry DIR] [--server URL] [--regenerate] [--dry] [--check]
 *   testid diff <fromVersion> <toVersion> [--registry DIR] [--server URL]
 *   testid gen-locators [--target robot|playwright|cypress] [--out DIR] [--registry DIR] [--server URL]
 *   testid gen-constants [--out FILE] [--registry DIR] [--server URL]
 *   testid affected <fromVersion> <toVersion> [--tests DIR[,DIR]] [--out-list FILE] [--registry DIR] [--server URL]
 *
 * The adapter is picked from the matched files (.vue -> VueAdapter, else HTML);
 * --adapter overrides. Mixed .vue/non-.vue runs must be split (or use --adapter).
 * `tag --check` is the CI gate: writes nothing, exits 1 if tagging is required.
 */
import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createTransport, LocalTransport } from './client/transport';
import { runPipeline } from './client/pipeline';
import { FrameworkAdapter } from './adapters/contract';
import { HtmlTemplateAdapter } from './adapters/html';
import { VueAdapter } from './adapters/vue';
import { AngularAdapter } from './adapters/angular';
import { ReactAdapter } from './adapters/react';
import { diffToMarkdown } from './registry/diff';
import { InMemoryStorage } from './registry/storage';
import { LocatorTarget, generateConstants } from './locators';
import { buildTestMap, buildTestMapForIds, affectedTests, affectedTestsToMarkdown, coverageReport, coverageToMarkdown } from './testmap';
import { readRuntimeRecord } from './runtime';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
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
    const checked = await runPipeline(adapter, checkTransport, files, config);
    if (checked.warnings.length) {
      console.warn(`${checked.warnings.length} identity warning(s):`);
      for (const w of checked.warnings) console.warn(`  - ${w.message}`);
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

  const result = await runPipeline(adapter, transport, files, config, { regenerate: !!flags.regenerate });

  for (const t of result.tagged) {
    if (flags.dry) { console.log(`--- ${t.file} (dry) ---\n${t.after}\n`); }
    else if (t.after !== t.before) { writeFileSync(t.file, t.after); console.log(`tagged ${t.file}`); }
  }
  console.log(`registry version ${result.version}${flags.server ? ` (remote ${flags.server})` : ` (${registryDir})`}`);
  if (result.overrides.length) console.log(`manual overrides: ${result.overrides.join(', ')}`);
  if (result.warnings.length) {
    console.warn(`\n${result.warnings.length} identity warning(s):`);
    for (const w of result.warnings) console.warn(`  - ${w.message}`);
  }
  const st = result.stats;
  console.log(`tagging coverage: ${st.tagged}/${st.elements} parsed elements tagged` +
    ` (${st.skipped_no_signal} no-signal, ${st.skipped_policy} policy-skipped)`);
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
  const out = generateConstants(snap);
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

async function cmdAffected(positional: string[], flags: Record<string, string | boolean>) {
  const transport = createTransport({ server: flags.server as string, registryDir: (flags.registry as string) ?? 'test-artifacts/testids' });
  const from = Number(positional[0]), to = Number(positional[1]);
  const d = await transport.diff(from, to);
  if (!d) { console.error('versions not found'); process.exit(2); }

  const testFiles = loadTestFiles(flags);

  // The map must cover ids on BOTH sides of the diff (removed ids are absent from the
  // `to` snapshot), so it is built from the diff's own id set — works over any transport.
  const ids = [...d.added, ...d.removed, ...d.modified, ...d.regenerated].map((e) => e.id);
  const affected = affectedTests(d, buildTestMapForIds(testFiles, ids));
  console.log(affectedTestsToMarkdown(affected));

  if (flags['out-list']) {
    const retest = [...new Set(affected.filter((a) => a.action === 're-test').flatMap((a) => a.tests))].sort();
    writeFileSync(flags['out-list'] as string, retest.join('\n') + (retest.length ? '\n' : ''));
    console.log(`wrote ${flags['out-list']} (${retest.length} test file(s) to re-run)`);
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
    default:
      console.log('usage: testid <tag|diff|gen-locators|gen-constants|affected|coverage> [...]  (add --server <url> to use a remote backend)');
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
