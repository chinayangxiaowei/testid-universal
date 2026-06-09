/**
 * End-to-end demo — proves the pipeline runs EMBEDDED (no server).
 *
 * The only thing that would change to use a remote backend instead is the
 * transport constructor — see the commented line. Calling code is identical.
 *
 * Run:  npx ts-node examples/demo.ts
 */
import { InMemoryStorage } from '../src/registry/storage';
import { LocalTransport /*, HttpTransport */ } from '../src/client/transport';
import { HtmlTemplateAdapter } from '../src/adapters/html';
import { runPipeline } from '../src/client/pipeline';
import { diff, diffToMarkdown } from '../src/registry/diff';

const LOGIN_V1 = `<form [formGroup]="form">
  <h2>Sign in</h2>
  <input type="email" formControlName="email" placeholder="you@example.com">
  <input type="password" formControlName="password">
  <button type="submit">Sign in</button>
  <a routerLink="/forgot">Forgot password?</a>
</form>`;

const LOGIN_V2 = `<form [formGroup]="form">
  <h2>Sign in</h2>
  <input type="email" formControlName="email" placeholder="you@example.com">
  <input type="password" formControlName="password" aria-label="Password">
  <button type="submit">Login</button>
  <a routerLink="/forgot">Forgot password?</a>
</form>`;

async function main() {
  // EMBEDDED mode — no server. Swap one line for remote:
  //   const transport = new HttpTransport('http://localhost:7337');
  const transport = new LocalTransport(new InMemoryStorage());
  const adapter = new HtmlTemplateAdapter();
  const file = 'src/app/login/login.component.html';

  console.log('=== RUN 1 (v1) ===');
  const r1 = await runPipeline(adapter, transport, [{ file, component: 'login', source: LOGIN_V1 }]);
  console.log(r1.tagged[0].after);
  const v1 = await transport.latest();

  console.log('\n=== RUN 2 (v2, after UI edits) ===');
  const r2 = await runPipeline(adapter, transport, [{ file, component: 'login', source: LOGIN_V2 }]);
  console.log(r2.tagged[0].after);
  const v2 = await transport.latest();

  console.log('\n=== DIFF v1 -> v2 ===');
  console.log(diffToMarkdown(diff(v1!, v2!)));

  console.log('=== ROBOT FRAMEWORK LOCATORS ===');
  console.log(Object.values((await transport.locators('robot'))!)[0]);

  // Determinism: identical input -> identical id set.
  const t2 = new LocalTransport(new InMemoryStorage());
  await runPipeline(adapter, t2, [{ file, component: 'login', source: LOGIN_V1 }]);
  const same = JSON.stringify(Object.keys((await t2.latest())!.entries).sort())
            === JSON.stringify(Object.keys(v1!.entries).sort());
  console.log('=== DETERMINISM CHECK ===\nidentical input -> identical id set:', same);
}

main().catch((e) => { console.error(e); process.exit(1); });
