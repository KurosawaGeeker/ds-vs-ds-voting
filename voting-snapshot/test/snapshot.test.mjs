import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { publishSnapshot } from '../src/worker.js';
import { createRuntime, initialize, sendVote } from './runtime.mjs';

test('workerd: scheduled publication persists fixed JSON and cache metadata; disabled publisher does nothing', async () => {
  const runtime = createRuntime();
  try {
    const DB = await runtime.getD1Database('DB');
    const SNAPSHOTS = await runtime.getR2Bucket('SNAPSHOTS');
    await initialize(DB);
    await sendVote(runtime, randomUUID(), { choice: 'right' });
    assert.equal((await publishSnapshot({ DB, SNAPSHOTS, PUBLISH_ENABLED: 'false' })).published, false);
    assert.equal(await SNAPSHOTS.head('results.json'), null);
    const worker = await runtime.getWorker();
    await worker.scheduled({ cron: '* * * * *' });
    const object = await SNAPSHOTS.get('results.json');
    const snapshot = await object.json();
    assert.equal(snapshot.leftVotes, 0);
    assert.equal(snapshot.rightVotes, 1);
    assert.equal(snapshot.revision, 1);
    assert.ok(Number.isSafeInteger(snapshot.capturedAt));
    assert.equal(object.httpMetadata.cacheControl, 'public, max-age=1, s-maxage=10');
    assert.equal(object.httpMetadata.contentType, 'application/json; charset=utf-8');
    assert.equal(object.customMetadata.revision, '1');
    assert.equal((await SNAPSHOTS.list()).objects.length, 1);
  } finally { await runtime.dispose(); }
});

for (const initialized of [false, true]) {
  test(`workerd: old publication cannot overwrite newer R2 snapshot (${initialized ? 'existing object' : 'initial object race'})`, async () => {
    const runtime = createRuntime();
    try {
      const DB = await runtime.getD1Database('DB');
      const SNAPSHOTS = await runtime.getR2Bucket('SNAPSHOTS');
      await initialize(DB);
      const env = { DB, SNAPSHOTS, PUBLISH_ENABLED: 'true' };
      if (initialized) await publishSnapshot(env);
      let oldRead;
      let resumeOld;
      const read = new Promise(resolve => { oldRead = resolve; });
      const resume = new Promise(resolve => { resumeOld = resolve; });
      const pausedDb = { withSession() { return { prepare(sql) { return { async first() {
        const row = await DB.withSession('first-primary').prepare(sql).first();
        oldRead();
        await resume;
        return row;
      } }; } }; } };
      const oldPublish = publishSnapshot({ ...env, DB: pausedDb });
      await read;
      await sendVote(runtime, randomUUID());
      assert.equal((await publishSnapshot(env)).published, true);
      resumeOld();
      assert.deepEqual(await oldPublish, { published: false, reason: 'concurrent_publish' });
      const object = await SNAPSHOTS.get('results.json');
      assert.equal((await object.json()).revision, 1);
      assert.equal((await SNAPSHOTS.list()).objects.length, 1);
    } finally { await runtime.dispose(); }
  });
}
