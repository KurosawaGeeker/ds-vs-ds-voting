import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const file of ['src/worker.js', 'public/app.js', 'public/runtime-config.js', 'scripts/demo.mjs', 'scripts/smoke-demo.mjs']) {
  const checked = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  assert.equal(checked.status, 0, `Syntax check failed: ${file}`);
}
for (const file of ['wrangler.jsonc', 'wrangler.web.jsonc']) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []);
}
const config = JSON.parse(await readFile('wrangler.web.jsonc', 'utf8'));
assert.equal(config.main, undefined);
assert.equal(config.assets.run_worker_first, false);
assert.deepEqual(JSON.parse(await readFile('wrangler.jsonc', 'utf8')).triggers.crons, []);
console.log('Syntax and safe-default configuration checks passed. This does not prove live cache or billing behavior.');
