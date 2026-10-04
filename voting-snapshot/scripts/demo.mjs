// localhost-only demo adapter. It is not a deployable Worker or CDN emulator.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime, initialize } from '../test/runtime.mjs';

const port = Number(process.env.DEMO_PORT ?? 8788);
const origin = `http://127.0.0.1:${port}`;
const runtime = createRuntime(fileURLToPath(new URL('../.local-demo/', import.meta.url)));
const db = await runtime.getD1Database('DB');
const bucket = await runtime.getR2Bucket('SNAPSHOTS');
await initialize(db);
const worker = await runtime.getWorker();
await worker.scheduled({ cron: '* * * * *' });
const timer = setInterval(() => worker.scheduled({ cron: '* * * * *' }).catch(() => console.error('Local publication failed')), 60000);
const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'application/javascript']], ['/style.css', ['style.css', 'text/css']]]);
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, origin).pathname;
    if (request.method === 'GET' && path === '/runtime-config.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      response.end(`window.VOTE_CONFIG=Object.freeze(${JSON.stringify({ resultsUrl: `${origin}/results.json`, voteUrl: `${origin}/vote`, turnstileSiteKey: '', pollingMs: 10000, staleAfterMs: 120000, localDemo: true })});`);
      return;
    }
    if (request.method === 'GET' && path === '/results.json') {
      const object = await bucket.get('results.json');
      if (!object) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': object.httpMetadata.contentType, 'Cache-Control': object.httpMetadata.cacheControl });
      response.end(await object.text());
      return;
    }
    if (request.method === 'POST' && path === '/vote') {
      if (request.headers.origin !== origin) { response.writeHead(403); response.end(); return; }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) { response.writeHead(413); response.end(); return; }
      }
      const vote = JSON.parse(body);
      // Only this non-deployable local adapter translates a local demo challenge.
      if (vote.token === `demo_${vote.voterId}`) vote.token = `valid:${vote.voterId}`;
      const result = await runtime.dispatchFetch('https://api.example.com/vote', {
        method: 'POST', headers: { Origin: 'https://vote.example.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.50' }, body: JSON.stringify(vote)
      });
      response.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(await result.text());
      return;
    }
    if (request.method === 'GET' && files.has(path)) {
      const [file, type] = files.get(path);
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      response.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
      return;
    }
    response.writeHead(404); response.end();
  } catch { response.writeHead(500); response.end('Local demo error'); }
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
console.log(`Local demo: ${origin} (mock verification; no Cloudflare account or remote payment/service calls)`);
async function stop() {
  clearInterval(timer);
  await new Promise(resolve => server.close(resolve));
  await runtime.dispose();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop().then(() => process.exit(0)); });
