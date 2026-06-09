import { describe, it, expect } from 'vitest';
import { runPipeline } from '../../src/client/pipeline';
import { LocalTransport } from '../../src/client/transport';
import { InMemoryStorage } from '../../src/registry/storage';
import { HtmlTemplateAdapter } from '../../src/adapters/html';

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
});
