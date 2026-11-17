import { describe, it, expect } from 'vitest';
import { runPipeline } from '../../src/client/pipeline';
import { LocalTransport } from '../../src/client/transport';
import { InMemoryStorage } from '../../src/registry/storage';
import { HtmlTemplateAdapter } from '../../src/adapters/html';
import { VueAdapter } from '../../src/adapters/vue';

describe('runPipeline', () => {
  it('surfaces identity warnings for an element with no stable signal', async () => {
    const transport = new LocalTransport(new InMemoryStorage());
    const r = await runPipeline(new HtmlTemplateAdapter(), transport,
      [{ file: 'x.html', component: 'login', source: '<button>Save</button>' }]);
    expect(r.warnings.some((w) => w.code === 'unstable-identity')).toBe(true);
  });

  it('keeps an element id stable across a copy edit (sticky)', async () => {
    const transport = new LocalTransport(new InMemoryStorage());
    const adapter = new HtmlTemplateAdapter();
    const r1 = await runPipeline(adapter, transport, [{ file: 'f.html', component: 'card', source: '<button>Save</button>' }]);
    const tagged = r1.tagged[0].after;
    expect(tagged).toContain('data-testid="card__button--save"');

    const edited = tagged.replace('>Save<', '>Save changes<');
    const r2 = await runPipeline(adapter, transport, [{ file: 'f.html', component: 'card', source: edited }]);
    expect(r2.tagged[0].after).toContain('data-testid="card__button--save"');
  });

  it('re-mints ids from current signals when regenerate is set', async () => {
    const transport = new LocalTransport(new InMemoryStorage());
    const adapter = new HtmlTemplateAdapter();
    const r1 = await runPipeline(adapter, transport, [{ file: 'f.html', component: 'card', source: '<button>Save</button>' }]);
    const edited = r1.tagged[0].after.replace('>Save<', '>Save changes<');
    const r2 = await runPipeline(adapter, transport, [{ file: 'f.html', component: 'card', source: edited }], undefined, { regenerate: true });
    expect(r2.tagged[0].after).toContain('data-testid="card__button--save-changes"');
    expect(r2.tagged[0].after).not.toContain('card__button--save"');
  });

  it('reports a symbol-definition change as modified while the id stays frozen', async () => {
    const v1 = `<template>
  <button @click="saveOrder">Save</button>
</template>

<script setup>
function saveOrder() { return 1; }
</script>
`;
    const transport = new LocalTransport(new InMemoryStorage());
    const adapter = new VueAdapter();
    const r1 = await runPipeline(adapter, transport, [{ file: 'X.vue', component: 'x', source: v1 }]);
    const tagged = r1.tagged[0].after;
    expect(tagged).toContain('data-testid="x__button--saveorder"');

    // Change ONLY the handler BODY; markup (and thus fingerprint) is untouched.
    const v2 = tagged.replace('return 1;', 'return 2;');
    await runPipeline(adapter, transport, [{ file: 'X.vue', component: 'x', source: v2 }]);

    const d = (await transport.diff(1, 2))!;
    expect(d.summary.modified).toBe(1);
    expect(d.modified[0].id).toBe('x__button--saveorder');
    expect(d.modified[0].changes.some((c) => c.field === 'symbol:saveOrder')).toBe(true);
  });
});

// Downstream: CI logs showed `[undefined]` — the CLI printed only the message, so the
// category was lost. The formatted line must lead with the warning code.
import { formatWarning } from '../../src/client/pipeline';

describe('formatWarning', () => {
  it('prefixes the warning code so CI can filter by category', () => {
    const line = formatWarning({ code: 'loop-multiplicity', element_type: 'button', identity: 'a::b', message: 'shared id' });
    expect(line).toBe('[loop-multiplicity] shared id');
  });
});
