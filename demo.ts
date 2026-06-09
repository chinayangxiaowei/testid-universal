/**
 * End-to-end demo — proves the whole framework-agnostic pipeline runs:
 *   parse (HTML adapter) -> backend tag -> registry v1
 *   edit the template     -> backend tag -> registry v2
 *   diff v1 vs v2 (rename + modify detection)
 *   generate Robot + Playwright locators
 *
 * Run:  npx ts-node examples/demo.ts
 */
import { InMemoryStorage } from '../src/registry/storage';
import { TestIdService } from '../src/server/service';
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

// v2: the submit button label changes "Sign in" -> "Login" (a rename),
//     and the password input gains an aria-label (a modify).
const LOGIN_V2 = `<form [formGroup]="form">
  <h2>Sign in</h2>
  <input type="email" formControlName="email" placeholder="you@example.com">
  <input type="password" formControlName="password" aria-label="Password">
  <button type="submit">Login</button>
  <a routerLink="/forgot">Forgot password?</a>
</form>`;

async function main() {
  const storage = new InMemoryStorage();
  const service = new TestIdService(storage);
  const adapter = new HtmlTemplateAdapter();
  const file = 'src/app/login/login.component.html';

  console.log('=== RUN 1 (v1) ===');
  const r1 = await runPipeline(adapter, service, [{ file, component: 'login', source: LOGIN_V1 }]);
  console.log(r1.tagged[0].after);
  const v1 = await service.latest();

  console.log('\n=== RUN 2 (v2, after UI edits) ===');
  const r2 = await runPipeline(adapter, service, [{ file, component: 'login', source: LOGIN_V2 }]);
  console.log(r2.tagged[0].after);
  const v2 = await service.latest();

  console.log('\n=== DIFF v1 -> v2 ===');
  console.log(diffToMarkdown(diff(v1!, v2!)));

  console.log('=== ROBOT FRAMEWORK LOCATORS ===');
  const robot = await service.locators('robot');
  console.log(Object.values(robot!)[0]);

  console.log('=== PLAYWRIGHT LOCATORS ===');
  const pw = await service.locators('playwright');
  console.log(Object.values(pw!)[0]);

  // Determinism check: re-running identical input must yield identical ids.
  const storage2 = new InMemoryStorage();
  const svc2 = new TestIdService(storage2);
  const again = await runPipeline(adapter, svc2, [{ file, component: 'login', source: LOGIN_V1 }]);
  const sameIds = JSON.stringify(Object.keys((await svc2.latest())!.entries).sort())
              === JSON.stringify(Object.keys(v1!.entries).sort());
  console.log('=== DETERMINISM CHECK ===');
  console.log('identical input -> identical id set:', sameIds);
}

main().catch((e) => { console.error(e); process.exit(1); });
