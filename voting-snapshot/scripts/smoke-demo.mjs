import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const socket = createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const child = spawn(process.execPath, ['scripts/demo.mjs'], { env: { ...process.env, DEMO_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => child.once('exit', resolve));
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local demo startup timed out')), 10000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Local demo exited: ${code}`)); });
    child.stderr.on('data', () => {});
    child.stdout.on('data', data => {
      if (data.toString().includes('Local demo:')) { clearTimeout(timeout); resolve(); }
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(origin)).status, 200);
  assert.ok((await (await fetch(`${origin}/runtime-config.js`)).text()).includes('"localDemo":true'));
  const snapshotResponse = await fetch(`${origin}/results.json`);
  assert.equal(snapshotResponse.status, 200);
  assert.equal(snapshotResponse.headers.get('Cache-Control'), 'public, max-age=1, s-maxage=10');
  const snapshot = await snapshotResponse.json();
  const voterId = randomUUID();
  const post = () => fetch(`${origin}/vote`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ voterId, choice: 'left', token: `demo_${voterId}` }) });
  const first = await post();
  assert.equal(first.status, 200);
  const accepted = await first.json();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.revision, snapshot.revision + 1);
  const retry = await post();
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  console.log('Local HTTP demo passed: HTML/config/R2 snapshot, durable vote ACK and idempotent retry. No remote service calls.');
} finally {
  child.kill('SIGTERM');
  await exited;
}
