import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runPipeline } from '../../src/client/pipeline';
import { LocalTransport } from '../../src/client/transport';
import { InMemoryStorage } from '../../src/registry/storage';
import { ReactAdapter } from '../../src/adapters/react';
import { VueAdapter } from '../../src/adapters/vue';
import { AngularAdapter } from '../../src/adapters/angular';
import { FrameworkAdapter } from '../../src/adapters/contract';

// Layer-2 source-dependency tracking (dep_defs): a change in a definition that a
// referenced handler DIRECTLY uses — same-file helper, imported function (through
// re-export barrels and tsconfig path aliases), hook, or Angular injected service
// method — must flag the linked element `modified` even though neither its id nor
// the handler's own text changed. Depth is capped at one hop past the handler.

type Files = Record<string, string>;

function project(files: Files): { root: string; write: (f: Files) => void } {
  const root = mkdtempSync(join(tmpdir(), 'testid-deps-'));
  const write = (fs: Files) => {
    for (const [p, c] of Object.entries(fs)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), c);
    }
  };
  write(files);
  return { root, write };
}

/** Run the pipeline over `pages` (paths relative to root) twice around `edit`. */
async function twoRuns(
  adapter: () => FrameworkAdapter, files: Files, pages: string[], edit: Files,
  opts: { deps?: boolean; deps2?: boolean } = {},
) {
  const { root, write } = project(files);
  const transport = new LocalTransport(new InMemoryStorage());
  const run = (deps?: boolean) =>
    runPipeline(adapter(), transport,
      pages.map((p) => ({ file: join(root, p), component: 'Page', source: readFileSync(join(root, p), 'utf8') })),
      undefined, deps === undefined ? undefined : { deps });
  const r1 = await run(opts.deps);
  write(edit);
  const r2 = await run(opts.deps2 ?? opts.deps);
  const diff = (await transport.diff(r1.version, r2.version))!;
  const fields = diff.modified.flatMap((m) => m.changes.map((c) => `${m.id} ${c.field}`)).sort();
  return { r1, r2, diff, fields, snap: (await transport.latest())! };
}

const API_V1 = `export function createOrder(form) { return post('/orders', form); }
export function deleteOrder(id) { return del('/orders/' + id); }
`;
const API_V2 = `export function createOrder(form) { if (!form.total) throw new Error('total'); return post('/orders', form); }
export function deleteOrder(id) { return del('/orders/' + id); }
`;
const react = () => new ReactAdapter();

describe('dep_defs — React', () => {
  it('downstream repro: changing an imported function the handler calls flags the element', async () => {
    const { fields, snap } = await twoRuns(react, {
      'src/api.js': API_V1,
      'src/Page.jsx': `import { createOrder } from './api';
export default function Page({ form }) {
  const submit = () => createOrder(form);
  return <button onClick={submit}>Go</button>;
}
`,
    }, ['src/Page.jsx'], { 'src/api.js': API_V2 });
    expect(fields).toEqual(['page__button--submit dep:submit>createOrder']);
    expect(Object.keys(snap.entries['page__button--submit'].dep_defs ?? {})).toEqual(['submit>createOrder']);
  });

  it('slices only the referenced export: editing a sibling export does not flag', async () => {
    const { fields } = await twoRuns(react, {
      'src/api.js': API_V1,
      'src/Page.jsx': `import { createOrder } from './api';
const Page = ({ form }) => { const submit = () => createOrder(form); return <button onClick={submit}>Go</button>; };
`,
    }, ['src/Page.jsx'], { 'src/api.js': API_V1.replace("'/orders/' + id", "'/v2/orders/' + id") });
    expect(fields).toEqual([]);
  });

  it('a template-referenced import resolves across the file (onClick={createOrder})', async () => {
    const { fields } = await twoRuns(react, {
      'src/api.js': API_V1,
      'src/Page.jsx': `import { createOrder } from './api';
const Page = () => <button onClick={createOrder}>Go</button>;
`,
    }, ['src/Page.jsx'], { 'src/api.js': API_V2 });
    expect(fields).toEqual(['page__button--createorder dep:createOrder>createOrder']);
  });

  it('same-file helper called by the handler', async () => {
    const SRC = (rule: string) => `function validate(f) { return ${rule}; }
const Page = ({ form }) => { const submit = () => validate(form) && send(form); return <button onClick={submit}>Go</button>; };
`;
    const { root, write } = project({ 'src/Page.jsx': SRC('f.total > 0') });
    const transport = new LocalTransport(new InMemoryStorage());
    const file = join(root, 'src/Page.jsx');
    const r1 = await runPipeline(react(), transport, [{ file, component: 'Page', source: readFileSync(file, 'utf8') }]);
    const r2 = await runPipeline(react(), transport, [{ file, component: 'Page', source: SRC('f.total > 10') }]);
    const d = (await transport.diff(r1.version, r2.version))!;
    expect(d.modified.flatMap((m) => m.changes.map((c) => c.field))).toEqual(['dep:submit>validate']);
    void write;
  });

  it('namespace import member access (api.createOrder)', async () => {
    const { fields } = await twoRuns(react, {
      'src/api.js': API_V1,
      'src/Page.jsx': `import * as api from './api';
const Page = ({ form }) => { const submit = () => api.createOrder(form); return <button onClick={submit}>Go</button>; };
`,
    }, ['src/Page.jsx'], { 'src/api.js': API_V2 });
    expect(fields).toEqual(['page__button--submit dep:submit>api.createOrder']);
  });

  it('hook: destructured handler from a custom hook follows into the hook body', async () => {
    const HOOK = (body: string) => `export function useOrders() { const save = (o) => ${body}; return { save }; }\n`;
    const { fields } = await twoRuns(react, {
      'src/hooks/useOrders.ts': HOOK('post(o)'),
      'src/Page.tsx': `import { useOrders } from './hooks/useOrders';
export default function Page() { const { save } = useOrders(); return <button onClick={save}>Save</button>; }
`,
    }, ['src/Page.tsx'], { 'src/hooks/useOrders.ts': HOOK('validate(o) && post(o)') });
    expect(fields).toEqual(['page__button--save dep:save>useOrders']);
  });

  it('follows re-export barrels to the real declaration (default + named + export *)', async () => {
    const files = {
      'src/services/orders.ts': API_V1,
      'src/services/index.ts': `export * from './orders';\n`,
      'src/Page.jsx': `import { createOrder } from './services';
const Page = ({ form }) => { const submit = () => createOrder(form); return <button onClick={submit}>Go</button>; };
`,
    };
    const { fields } = await twoRuns(react, files, ['src/Page.jsx'], { 'src/services/orders.ts': API_V2 });
    expect(fields).toEqual(['page__button--submit dep:submit>createOrder']);
    const renamed = await twoRuns(react, { ...files, 'src/services/index.ts': `export { createOrder as makeOrder } from './orders';\n`,
      'src/Page.jsx': `import { makeOrder } from './services';
const Page = ({ form }) => { const submit = () => makeOrder(form); return <button onClick={submit}>Go</button>; };
` }, ['src/Page.jsx'], { 'src/services/orders.ts': API_V2 });
    expect(renamed.fields).toEqual(['page__button--submit dep:submit>makeOrder']);
  });

  it('resolves tsconfig path aliases (@/api)', async () => {
    const { fields } = await twoRuns(react, {
      'tsconfig.json': `{
  // comments are allowed in tsconfig
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, },
}
`,
      'src/api.ts': API_V1,
      'src/pages/Page.tsx': `import { createOrder } from '@/api';
const Page = ({ form }: any) => { const submit = () => createOrder(form); return <button onClick={submit}>Go</button>; };
`,
    }, ['src/pages/Page.tsx'], { 'src/api.ts': API_V2 });
    expect(fields).toEqual(['page__button--submit dep:submit>createOrder']);
  });

  it('honest boundary: an unresolvable local-looking import is COUNTED, never silently green; bare packages are out of scope', async () => {
    const { r1, fields } = await twoRuns(react, {
      'src/Page.jsx': `import { useState } from 'react';
import { createOrder } from '@/api';
const Page = ({ form }) => { const [x] = useState(0); const submit = () => createOrder(form) && useState; return <button onClick={submit}>Go</button>; };
`,
    }, ['src/Page.jsx'], {});
    expect(fields).toEqual([]);
    expect(r1.deps.enabled).toBe(true);
    expect(r1.deps.unresolved).toEqual(['@/api#createOrder']);
  });

  it('does not follow a third hop (createOrder -> post is not tracked)', async () => {
    const { fields } = await twoRuns(react, {
      'src/http.js': `export function post(u, b) { return fetch(u, { method: 'POST', body: b }); }\n`,
      'src/api.js': `import { post } from './http';\nexport function createOrder(form) { return post('/orders', form); }\n`,
      'src/Page.jsx': `import { createOrder } from './api';
const Page = ({ form }) => { const submit = () => createOrder(form); return <button onClick={submit}>Go</button>; };
`,
    }, ['src/Page.jsx'], { 'src/http.js': `export function post(u, b) { return fetch(u, { method: 'PUT', body: b }); }\n` });
    expect(fields).toEqual([]);
  });
});

describe('dep_defs — upgrade & switch are noise-free', () => {
  const files = {
    'src/api.js': API_V1,
    'src/Page.jsx': `import { createOrder } from './api';
const Page = ({ form }) => { const submit = () => createOrder(form); return <button onClick={submit}>Go</button>; };
`,
  };

  it('a registry written without dep tracking (pre-upgrade / --no-deps) produces no noise when tracking turns on', async () => {
    const { diff, snap } = await twoRuns(react, files, ['src/Page.jsx'], {}, { deps: false, deps2: true });
    expect(diff.modified).toEqual([]);
    expect(snap.entries['page__button--submit'].dep_defs).toBeDefined();
  });

  it('turning tracking off produces no noise either', async () => {
    const { diff, r2 } = await twoRuns(react, files, ['src/Page.jsx'], { 'src/api.js': API_V2 }, { deps: true, deps2: false });
    expect(diff.modified).toEqual([]);
    expect(r2.deps.enabled).toBe(false);
  });

  it('--no-deps leaves first-hop symbol tracking unchanged', async () => {
    const { r1, snap } = await twoRuns(react, files, ['src/Page.jsx'], {}, { deps: false });
    expect(r1.deps.enabled).toBe(false);
    expect(Object.keys(snap.entries['page__button--submit'].symbol_defs)).toEqual(['submit']);
    expect(snap.entries['page__button--submit'].dep_defs).toBeUndefined();
  });
});

describe('dep_defs — Vue <script setup>', () => {
  it('handler calling an imported service function', async () => {
    const SFC = `<template>
  <button @click="submit">Go</button>
</template>
<script setup lang="ts">
import { createOrder } from './api';
const props = defineProps<{ form: any }>();
function submit() { createOrder(props.form); }
</script>
`;
    const { fields } = await twoRuns(() => new VueAdapter(), { 'src/api.ts': API_V1, 'src/Page.vue': SFC },
      ['src/Page.vue'], { 'src/api.ts': API_V2 });
    expect(fields).toEqual(['page__button--submit dep:submit>createOrder']);
  });
});

describe('dep_defs — store / hook instance alias (Pinia, custom hooks)', () => {
  it('Vue: `const tasks = useTaskStore()` then `tasks.claimTask()` follows into the store definition', async () => {
    const STORE = (body: string) => `import { defineStore } from 'pinia';
export const useTaskStore = defineStore('tasks', { actions: { claimTask(id: string) { ${body} } } });
`;
    const SFC = `<template>
  <button @click="claim">Claim</button>
</template>
<script setup lang="ts">
import { useTaskStore } from '../stores/tasks';
const tasks = useTaskStore();
function claim() { tasks.claimTask('t1'); }
</script>
`;
    const { fields } = await twoRuns(() => new VueAdapter(),
      { 'src/stores/tasks.ts': STORE('this.claimed = id;'), 'src/views/Page.vue': SFC },
      ['src/views/Page.vue'], { 'src/stores/tasks.ts': STORE("if (!id) throw new Error('id'); this.claimed = id;") });
    expect(fields).toEqual(['page__button--claim dep:claim>tasks.claimTask']);
  });

  it('member precision: editing ANOTHER store action does not flag', async () => {
    const STORE = (other: string) => `import { defineStore } from 'pinia';
export const useTaskStore = defineStore('tasks', {
  state: () => ({ claimed: '' }),
  actions: { claimTask(id: string) { this.claimed = id; }, removeTask(id: string) { ${other} } },
});
`;
    const SFC = `<template>
  <button @click="claim">Claim</button>
</template>
<script setup lang="ts">
import { useTaskStore } from '../stores/tasks';
const tasks = useTaskStore();
function claim() { tasks.claimTask('t1'); }
</script>
`;
    const { fields } = await twoRuns(() => new VueAdapter(),
      { 'src/stores/tasks.ts': STORE('return id;'), 'src/views/Page.vue': SFC },
      ['src/views/Page.vue'], { 'src/stores/tasks.ts': STORE('console.log(id); return id;') });
    expect(fields).toEqual([]);
  });

  it('React: `const orders = useOrders()` then `orders.save()` follows into the hook', async () => {
    const HOOK = (body: string) => `export function useOrders() { return { save: (o) => ${body} }; }\n`;
    const { fields } = await twoRuns(react, {
      'src/useOrders.js': HOOK('post(o)'),
      'src/Page.jsx': `import { useOrders } from './useOrders';
export default function Page({ o }) { const orders = useOrders(); const save = () => orders.save(o); return <button onClick={save}>Save</button>; }
`,
    }, ['src/Page.jsx'], { 'src/useOrders.js': HOOK('validate(o) && post(o)') });
    expect(fields).toEqual(['page__button--save dep:save>orders.save']);
  });
});

describe('dep_defs — package factories keep their declaration', () => {
  it('`const email = ref(...)` (bare-package factory) is still tracked by its declaration text', async () => {
    const SFC = (init: string) => `<template>
  <button @click="submit">Go</button>
</template>
<script setup lang="ts">
import { ref } from 'vue';
const email = ref(${init});
function submit() { send(email.value); }
</script>
`;
    const { root, write } = project({ 'src/Page.vue': SFC("''") });
    void write;
    const transport = new LocalTransport(new InMemoryStorage());
    const file = join(root, 'src/Page.vue');
    const r1 = await runPipeline(new VueAdapter(), transport, [{ file, component: 'Page', source: SFC("''") }]);
    const r2 = await runPipeline(new VueAdapter(), transport, [{ file, component: 'Page', source: SFC("'a@b.c'") }]);
    const d = (await transport.diff(r1.version, r2.version))!;
    expect(d.modified.flatMap((m) => m.changes.map((c) => c.field))).toEqual(['dep:submit>email.value']);
    expect(r1.deps.unresolved).toEqual([]);
  });
});

describe('dep_defs — Angular companion .ts', () => {
  it('method calling an injected service (constructor param + inject()) follows into the service method', async () => {
    const SVC = (rule: string) => `import { Injectable } from '@angular/core';
@Injectable({ providedIn: 'root' })
export class OrderService {
  create(form: any) { return ${rule}; }
  remove(id: string) { return id; }
}
`;
    const files = {
      'src/app/order.service.ts': SVC('form'),
      'src/app/page.component.html': `<button (click)="submit()">Go</button>\n<button (click)="cancel()">Cancel</button>\n`,
      'src/app/page.component.ts': `import { Component, inject } from '@angular/core';
import { OrderService } from './order.service';
@Component({ selector: 'app-page', templateUrl: './page.component.html' })
export class PageComponent {
  private svc2 = inject(OrderService);
  constructor(private svc: OrderService) {}
  submit() { this.svc.create({}); }
  cancel() { this.svc2.remove('x'); }
}
`,
    };
    const { fields } = await twoRuns(() => new AngularAdapter(), files, ['src/app/page.component.html'],
      { 'src/app/order.service.ts': SVC('validate(form)') });
    expect(fields).toEqual(['page__button--submit dep:submit>svc.create']);
  });
});

// Honest degradation (downstream): what a hop-1 definition ITSELF depends on (layer 3)
// and dynamic dispatch are not tracked — but they must be REPORTED, never silently
// green. `dep_limited` lists them per element; it is a report, not a change signal.
describe('dep_limited — beyond-depth & dynamic dispatch are reported', () => {
  const PAGE = `import { createOrder } from './api';
const Page = ({ form }) => { const submit = () => createOrder(form); return <button onClick={submit}>Go</button>; };
`;
  const limitedOf = async (files: Files, page = 'src/Page.jsx') => {
    const { r1, snap } = await twoRuns(react, files, [page], {});
    const e = Object.values(snap.entries)[0];
    return { stats: r1.deps.limited, entry: e.dep_limited ?? [] };
  };

  it('layer 3 in the same module: createOrder -> validate', async () => {
    const { stats, entry } = await limitedOf({
      'src/api.js': `function validate(f) { return f.total > 0; }
export function createOrder(form) { validate(form); return post('/orders', form); }
`,
      'src/Page.jsx': PAGE,
    });
    expect(entry).toEqual(['submit>createOrder>validate']);
    expect(stats).toEqual(['submit>createOrder>validate']);
  });

  it('layer 3 through a relative import of the hop-1 module', async () => {
    const { entry } = await limitedOf({
      'src/validate.js': `export const validate = (f) => f.total > 0;`,
      'src/api.js': `import { validate } from './validate';
export function createOrder(form) { validate(form); return post('/orders', form); }
`,
      'src/Page.jsx': PAGE,
    });
    expect(entry).toEqual(['submit>createOrder>validate']);
  });

  it('bare packages and globals in the hop-1 body are out of scope by design (not reported)', async () => {
    const { entry, stats } = await limitedOf({
      'src/api.js': `import axios from 'axios';
export function createOrder(form) { console.log(form); return axios.post('/orders', form); }
`,
      'src/Page.jsx': PAGE,
    });
    expect(entry).toEqual([]);
    expect(stats).toEqual([]);
  });

  it('same-file helper calling another same-file helper', async () => {
    const { entry } = await limitedOf({
      'src/Page.jsx': `function normalize(f) { return f; }
function validate(f) { return normalize(f).total > 0; }
const Page = ({ form }) => { const submit = () => validate(form); return <button onClick={submit}>Go</button>; };
`,
    });
    expect(entry).toEqual(['submit>validate>normalize']);
  });

  it('dynamic dispatch in the handler (computed member call) is reported', async () => {
    const { entry } = await limitedOf({
      'src/Page.jsx': `const handlers = { a: () => 1, b: () => 2 };
const Page = ({ mode }) => { const submit = () => handlers[mode](); return <button onClick={submit}>Go</button>; };
`,
    });
    expect(entry).toContain('submit>(dynamic) handlers[mode]');
  });

  it('dynamic dispatch in a hop-1 body (calling a callback parameter) is reported', async () => {
    const { entry } = await limitedOf({
      'src/api.js': `export function createOrder(form, done) { done(form); }`,
      'src/Page.jsx': PAGE,
    });
    expect(entry).toEqual(['submit>createOrder>(dynamic) done']);
  });

  it('a template-referenced import: what it calls is beyond depth', async () => {
    const { entry } = await limitedOf({
      'src/api.js': `function validate(f) { return !!f; }
export function createOrder(form) { return validate(form); }
`,
      'src/Page.jsx': `import { createOrder } from './api';
const Page = () => <button onClick={createOrder}>Go</button>;
`,
    });
    expect(entry).toEqual(['createOrder>createOrder>validate']);
  });

  it('--no-deps reports nothing', async () => {
    const { r1 } = await twoRuns(react, {
      'src/api.js': `function validate(f) { return f; }\nexport function createOrder(form) { return validate(form); }\n`,
      'src/Page.jsx': PAGE,
    }, ['src/Page.jsx'], {}, { deps: false });
    expect(r1.deps.limited).toEqual([]);
  });

  it('dep_limited is a report, not a change signal: gaining a layer-3 ref only flags via the hop-1 text', async () => {
    const { diff } = await twoRuns(react, {
      'src/api.js': `export function createOrder(form) { return form; }\n`,
      'src/Page.jsx': PAGE,
    }, ['src/Page.jsx'], { 'src/api.js': `function v(f) { return f; }\nexport function createOrder(form) { return form; }\n` });
    expect(diff.summary.modified).toBe(0); // v is unused by createOrder: nothing changed in scope
  });
});

describe('dep scoping — parameters shadow same-named declarations elsewhere in the module', () => {
  it('a hop-1 param named like another function\'s local is not a dependency (fast-team store repro)', async () => {
    const { r1 } = await twoRuns(react, {
      'src/useStore.js': `export function useStore() {
  return {
    add(input) { const id = 't-' + input.n; return id; },
    claim(id, by) { return [id, by]; },
  };
}
`,
      'src/Page.jsx': `import { useStore } from './useStore';
const Page = () => { const s = useStore(); const go = () => s.claim('x', 'me'); return <button onClick={go}>Go</button>; };
`,
    }, ['src/Page.jsx'], {});
    expect(r1.deps.limited).toEqual([]);
  });
});

describe('dep_limited — options-object `this.<method>()` (Pinia actions)', () => {
  it('an action calling a sibling via this.persist() is reported beyond depth', async () => {
    const { r1 } = await twoRuns(() => new VueAdapter(), {
      'src/stores/tasks.ts': `import { defineStore } from 'pinia';
export const useTaskStore = defineStore('tasks', {
  state: () => ({ tasks: [] as string[] }),
  actions: {
    persist() { localStorage.setItem('k', JSON.stringify(this.tasks)); },
    claimTask(id: string) { this.tasks.push(id); this.persist(); },
  },
});
`,
      'src/Page.vue': `<script setup lang="ts">
import { useTaskStore } from './stores/tasks';
const tasks = useTaskStore();
function claim() { tasks.claimTask('x'); }
</script>
<template><button @click="claim">Claim</button></template>
`,
    }, ['src/Page.vue'], {});
    expect(r1.deps.limited).toContain('claim>tasks.claimTask>this.persist');
  });
});
