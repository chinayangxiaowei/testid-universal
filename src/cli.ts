#!/usr/bin/env node
/**
 * testid — the convenient entry point.
 *
 * By default it runs FULLY EMBEDDED: no server to start, registry persisted as
 * JSON files (just like the original tool). Add `--server <url>` and the exact
 * same commands run against a remote backend instead. Nothing else changes.
 *
 *   testid tag <paths...> [--ext .html|.vue] [--adapter html|vue] [--attr data-testid]
 *              [--registry DIR] [--server URL] [--regenerate] [--dry]
 *   testid diff <fromVersion> <toVersion> [--registry DIR] [--server URL]
 *   testid gen-locators [--target robot|playwright|cypress] [--out DIR] [--registry DIR] [--server URL]
 *
 * The adapter is picked from the matched files (.vue -> VueAdapter, else HTML);
 * --adapter overrides. Mixed .vue/non-.vue runs must be split (or use --adapter).
 */
import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createTransport } from './client/transport';
import { runPipeline } from './client/pipeline';
import { FrameworkAdapter } from './adapters/contract';
import { HtmlTemplateAdapter } from './adapters/html';
import { VueAdapter } from './adapters/vue';
import { diffToMarkdown } from './registry/diff';
import { LocatorTarget } from './locators';

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

  // Pick the adapter from the matched file set; --adapter overrides.
  const vueCount = paths.filter((p) => p.endsWith('.vue')).length;
  const choice = (flags.adapter as string)
    ?? (vueCount === paths.length ? 'vue' : vueCount === 0 ? 'html' : 'mixed');
  if (choice !== 'vue' && choice !== 'html') {
    console.error(choice === 'mixed'
      ? 'mixed .vue and non-.vue files matched; run them separately or pass --adapter <html|vue>'
      : `unknown adapter "${choice}" (expected html or vue)`);
    process.exit(2);
  }
  const adapter: FrameworkAdapter = choice === 'vue' ? new VueAdapter() : new HtmlTemplateAdapter();

  const files = paths.map((file) => ({
    file, component: componentOf(file), source: readFileSync(file, 'utf8'),
  }));

  const config = flags.attr ? { attributeName: flags.attr as string } : undefined;
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

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case 'tag': return cmdTag(positional, flags);
    case 'diff': return cmdDiff(positional, flags);
    case 'gen-locators': return cmdGenLocators(flags);
    default:
      console.log('usage: testid <tag|diff|gen-locators> [...]  (add --server <url> to use a remote backend)');
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
