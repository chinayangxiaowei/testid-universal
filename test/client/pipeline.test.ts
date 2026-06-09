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
});
