/**
 * HTTP transport — a zero-dependency REST shell around TestIdService.
 *
 * Endpoints:
 *   POST /tag            { nodes, config? }                  -> TagResponse
 *   GET  /registry/latest                                    -> RegistrySnapshot
 *   GET  /diff?from=1&to=2&threshold=0.8                     -> DiffResult
 *   GET  /locators?target=robot|playwright|cypress|webdriverio|selenium-python|testcafe -> { [file]: content }
 *
 * Uses only node:http so it runs anywhere Node runs, with nothing to install.
 * In production you'd put this behind Express/Fastify + auth — but the service
 * core above stays identical.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { TestIdService } from './service';
import { RegistryStorage } from '../registry/storage';

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(json);
}

export function createApp(storage: RegistryStorage) {
  const service = new TestIdService(storage);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/tag') {
        return send(res, 200, await service.tag(await readBody(req)));
      }
      if (req.method === 'GET' && url.pathname === '/registry/latest') {
        const snap = await service.latest();
        return snap ? send(res, 200, snap) : send(res, 404, { error: 'no registry yet' });
      }
      if (req.method === 'GET' && url.pathname === '/diff') {
        const from = Number(url.searchParams.get('from'));
        const to = Number(url.searchParams.get('to'));
        const threshold = Number(url.searchParams.get('threshold') ?? '0.8');
        const d = await service.diff(from, to, threshold);
        return d ? send(res, 200, d) : send(res, 404, { error: 'version not found' });
      }
      if (req.method === 'GET' && url.pathname === '/locators') {
        const target = (url.searchParams.get('target') ?? 'robot') as import('../locators').LocatorTarget;
        const files = await service.locators(target, url.searchParams.get('attr') ?? undefined);
        return files ? send(res, 200, files) : send(res, 404, { error: 'no registry yet' });
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  });
}

// Allow `ts-node src/server/http.ts` to boot a live server.
if (require.main === module) {
  const { JsonFileStorage } = require('../registry/storage');
  const port = Number(process.env.PORT ?? 7337);
  createApp(new JsonFileStorage(process.env.REGISTRY_DIR ?? './test-artifacts/testids'))
    .listen(port, () => console.log(`testid-universal backend on http://localhost:${port}`));
}
