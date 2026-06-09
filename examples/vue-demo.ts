/**
 * End-to-end Vue demo: a real .vue SFC -> tag -> diff -> Playwright locators.
 *
 * Same engine, registry, diff and locators as the HTML demo — only the adapter
 * changed. That is the whole thesis: a framework is one adapter, nothing else.
 *
 * Run:  npx ts-node examples/vue-demo.ts
 */
import { InMemoryStorage } from '../src/registry/storage';
import { LocalTransport } from '../src/client/transport';
import { VueAdapter, VUETIFY_TAG_MAP } from '../src/adapters/vue';
import { runPipeline } from '../src/client/pipeline';
import { diff, diffToMarkdown } from '../src/registry/diff';

const LOGIN_V1 = `<template>
  <v-form>
    <v-text-field v-model="email" type="email" placeholder="you@example.com" />
    <v-text-field v-model="password" type="password" />
    <v-btn type="submit">Sign in</v-btn>
    <router-link to="/forgot">Forgot password?</router-link>
  </v-form>
</template>

<script setup>
import { ref } from 'vue';
const email = ref('');
const password = ref('');
</script>
`;

const LOGIN_V2 = `<template>
  <v-form>
    <v-text-field v-model="email" type="email" placeholder="you@example.com" />
    <v-text-field v-model="password" type="password" aria-label="Password" />
    <v-btn type="submit">Login</v-btn>
    <router-link to="/forgot">Forgot password?</router-link>
  </v-form>
</template>

<script setup>
import { ref } from 'vue';
const email = ref('');
const password = ref('');
</script>
`;

async function main() {
  const transport = new LocalTransport(new InMemoryStorage());
  const adapter = new VueAdapter(VUETIFY_TAG_MAP); // Vuetify components classify as native equivalents
  const file = 'src/pages/Login.vue';

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

  console.log('=== PLAYWRIGHT LOCATORS ===');
  console.log(Object.values((await transport.locators('playwright'))!)[0]);
}

main().catch((e) => { console.error(e); process.exit(1); });
