#!/usr/bin/env node
/**
 * Reference CI router for testid-universal — copy into your repo and adjust.
 *
 * Answers one question per PR: which e2e tests must run? It never writes your
 * sources or your committed registry:
 *
 *   1. copies the committed registry to a temp dir and tags the CURRENT sources into
 *      that copy (in memory for the sources) -> `to` version;
 *   2. `from` = the registry version committed at --base (merge-base mode), or the
 *      version in a --since green-anchor file;
 *   3. diff from -> to, routed to test cases;
 *   4. honesty rule: if the git diff touches source files OUTSIDE the tagged set,
 *      upgrade to the full suite (unless --trust-deps — see the tutorial);
 *   5. beyond-depth fallback: tests of elements whose untracked (layer 3+ / dynamic)
 *      dependencies MAY have changed are added — the element's own file changed, or
 *      (with --trust-deps) any untagged source changed; without git info (--since) all;
 *   6. writes retest.txt + a Markdown report, and `mode=full|selective|none`
 *      (to $GITHUB_OUTPUT when present).
 *
 * Usage:
 *   node ci-testid.mjs --src src --ext .vue --registry .testids --tests e2e --base origin/main
 *   node ci-testid.mjs ... --since .testids-green.json        # green-anchor mode
 *   options: --adapter vue|react|angular|html  --out retest.txt  --report testid-report.md
 *            --no-limited (drop beyond-depth fallback tests)  --trust-deps  --full
 *
 * Exit: 0 routed (see mode), 1 sources need tagging / registry missing, 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import {
  AngularAdapter, HtmlTemplateAdapter, ReactAdapter, VueAdapter,
  JsonFileStorage, LocalTransport, runPipeline,
  affectedTestCases, affectedTestCasesToMarkdown, buildTestCaseMapForIds, buildTestMapForIds,
  depthLimitedTests, depthLimitedToMarkdown, retestFiles,
} from 'testid-universal';

// ---- args -------------------------------------------------------------------------
const BOOL = new Set(['no-limited', 'trust-deps', 'full']);
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) usage(`unexpected argument ${a}`);
  const k = a.slice(2);
  args[k] = BOOL.has(k) ? true : process.argv[++i];
}
function usage(msg) { console.error(`ci-testid: ${msg}`); process.exit(2); }

const SRC = (args.src ?? 'src').split(',');
const EXTS = (args.ext ?? '.vue').split(',');
const REGISTRY = args.registry ?? '.testids';
const TESTS = (args.tests ?? 'e2e').split(',');
const OUT = args.out ?? 'retest.txt';
const REPORT = args.report ?? 'testid-report.md';
const SOURCE_EXT = /\.(vue|jsx?|tsx?|mjs|cjs|html|svelte)$/;

// ---- helpers ----------------------------------------------------------------------
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
function walk(paths, keep) {
  const out = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p)) if (e !== 'node_modules' && !e.startsWith('.')) out.push(...walk([join(p, e)], keep));
    } else if (keep(p)) out.push(p);
  }
  return out;
}
function adapterFor(files) {
  const pick = args.adapter
    ?? (files.every((f) => f.endsWith('.vue')) ? 'vue' : files.every((f) => /\.(jsx|tsx)$/.test(f)) ? 'react' : 'html');
  return { vue: () => new VueAdapter(), react: () => new ReactAdapter(), angular: () => new AngularAdapter(), html: () => new HtmlTemplateAdapter() }[pick]?.()
    ?? usage(`unknown --adapter ${pick}`);
}
function finish(mode, files, report) {
  writeFileSync(OUT, files.join('\n') + (files.length ? '\n' : ''));
  writeFileSync(REPORT, report);
  console.log(report);
  console.log(`mode=${mode} (${files.length} test file(s) in ${OUT})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  process.exit(0);
}

if (args.full) finish('full', [], '# testid: full suite (--full)\n');

// ---- 1. tag the current sources into a temp copy of the registry -------------------
if (!existsSync(join(REGISTRY, 'latest.json'))) {
  console.error(`ci-testid: no registry at ${REGISTRY} -- run \`testid tag\` locally and commit it`);
  process.exit(1);
}
const sources = walk(SRC, (f) => EXTS.includes(extname(f)));
if (!sources.length) usage(`no ${EXTS.join(',')} files under ${SRC.join(',')}`);
const scratch = mkdtempSync(join(tmpdir(), 'testid-ci-'));
cpSync(REGISTRY, scratch, { recursive: true });
const transport = new LocalTransport(new JsonFileStorage(scratch));
const files = sources.map((file) => ({ file, component: basename(file).replace(/\.[^.]+$/, '').replace(/\.component$/, ''), source: readFileSync(file, 'utf8') }));
const run = await runPipeline(adapterFor(sources), transport, files);
const untagged = run.tagged.filter((t) => t.after !== t.before).map((t) => t.file);
if (untagged.length) {
  // Same gate as `testid tag --check`: ids must be written and committed by a human run.
  console.error(`ci-testid: ${untagged.length} file(s) need tagging -- run \`testid tag\` and commit:\n  ${untagged.join('\n  ')}`);
  process.exit(1);
}
const to = run.version;

// ---- 2. the baseline version -------------------------------------------------------
let from;
if (args.base) {
  const base = git('merge-base', args.base, 'HEAD');
  const rel = relative(git('rev-parse', '--show-toplevel'), resolve(REGISTRY, 'latest.json')).split('\\').join('/');
  try { from = JSON.parse(git('show', `${base}:${rel}`)).version; } catch { from = null; }
  if (from == null) finish('full', [], `# testid: full suite\n\nNo registry committed at merge-base ${base.slice(0, 8)} -- nothing to diff against.\n`);
} else if (args.since) {
  from = JSON.parse(readFileSync(args.since, 'utf8')).version;
} else usage('pass --base <ref> (merge-base mode) or --since <green-anchor file>');

// ---- 3. route ---------------------------------------------------------------------
const testFiles = walk(TESTS, (f) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f)).map((file) => ({ file, source: readFileSync(file, 'utf8') }));
const d = await transport.diff(from, to);
if (!d) { console.error(`ci-testid: registry versions v${from}/v${to} not found`); process.exit(1); }
const ids = [...d.added, ...d.removed, ...d.modified, ...d.regenerated].map((e) => e.id);
const affected = affectedTestCases(d, buildTestCaseMapForIds(testFiles, ids));
const latest = await transport.latest();
const limitedIds = Object.keys(latest.entries).filter((id) => latest.entries[id].dep_limited?.length);
const limited = limitedIds.length ? depthLimitedTests(latest, buildTestMapForIds(testFiles, limitedIds)) : [];
let report = `# testid routing: v${from} -> v${to}\n\n` + affectedTestCasesToMarkdown(affected) + '\n' + depthLimitedToMarkdown(limited);
const drift = affected.filter((a) => a.anchor_drift).map((a) => a.id);
if (drift.length) report += `\n⚠ anchor drift on ${drift.join(', ')} -- re-check what those tests assert.\n`;
if (run.deps.unresolved.length) report += `\n⚠ UNRESOLVED local imports (changes there trigger nothing): ${run.deps.unresolved.join(', ')}\n`;

// ---- 4. honesty rule: changes outside the tagged set -> full suite ------------------
let changed = null; // absolute paths of changed non-test source files; null = unknown (--since)
let outside = [];
if (args.base) {
  const top = git('rev-parse', '--show-toplevel');
  const tagged = new Set(sources.map((f) => resolve(f)));
  const testRoots = TESTS.map((t) => resolve(t));
  changed = new Set(git('diff', '--name-only', `${args.base}...HEAD`).split('\n').filter(Boolean)
    .map((f) => resolve(top, f)).filter((f) => SOURCE_EXT.test(f) && !testRoots.some((r) => f.startsWith(r + '/'))));
  outside = [...changed].filter((f) => existsSync(f) && !tagged.has(f));
  if (outside.length && !args['trust-deps']) {
    finish('full', [], report + `\n## Full suite\n\nThe diff touches ${outside.length} source file(s) outside the tagged set ` +
      `(${outside.map((f) => relative(top, f)).join(', ')}). Only one hop past a handler is tracked, so the ` +
      `selective list cannot be trusted -- running everything. Pass --trust-deps to rely on dep tracking instead.\n`);
  }
}

// ---- 5. beyond-depth fallback: only where untracked code may have changed ----------
const fallback = args['no-limited'] ? [] : limited.filter((x) => {
  if (changed == null || outside.length) return true; // unknown, or untagged code changed (--trust-deps)
  const file = latest.entries[x.id].file;
  return file != null && changed.has(resolve(file)); // its own file changed (same-file layer 3)
});
if (fallback.length) report += `\nBeyond-depth fallback added for: ${fallback.map((x) => x.id).join(', ')}\n`;
const retest = retestFiles(affected, fallback);

finish(retest.length ? 'selective' : 'none', retest, report);
