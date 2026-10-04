import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, initialize, sendVote } from './runtime.mjs';

test('workerd: valid vote commits ledger and total before ACK; retry remains one vote after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vote-snapshot-'));
  let runtime = createRuntime(directory);
  try {
    let db = await runtime.getD1Database('DB');
    await initialize(db);
    const id = randomUUID();
    let response = await sendVote(runtime, id);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, duplicate: false, choice: 'left', revision: 1 });
    const stored = await db.prepare('SELECT * FROM votes').first();
    assert.equal(stored.voter_id, id);
    assert.equal(stored.ip_hash.length, 64);
    assert.notEqual(stored.ip_hash, '192.0.2.10');
    assert.equal((await db.prepare('SELECT left_votes FROM totals').first()).left_votes, 1);
    await runtime.dispose();
    runtime = createRuntime(directory);
    db = await runtime.getD1Database('DB');
    response = await sendVote(runtime, id, { choice: 'right', token: 'invalid:unused' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).duplicate, true);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM votes').first()).count, 1);
    assert.equal((await db.prepare('SELECT right_votes FROM totals').first()).right_votes, 0);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('workerd: invalid, mismatched, reused token and wrong origin never add a vote', async () => {
  const runtime = createRuntime();
  try {
    const db = await runtime.getD1Database('DB');
    await initialize(db);
    for (const mode of ['invalid', 'wrong-host', 'wrong-action']) {
      const id = randomUUID();
      assert.equal((await sendVote(runtime, id, { token: `${mode}:${id}` })).status, 403);
    }
    const id = randomUUID();
    assert.equal((await sendVote(runtime, id, { token: `valid:${randomUUID()}` })).status, 403);
    assert.equal((await sendVote(runtime, id, { origin: 'https://attacker.example' })).status, 403);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM votes').first()).count, 0);
    const token = `valid:${id}`;
    assert.equal((await sendVote(runtime, id, { token })).status, 200);
    assert.equal((await sendVote(runtime, randomUUID(), { token })).status, 403);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM votes').first()).count, 1);
    assert.equal((await runtime.dispatchFetch('https://api.example.com/results.json')).status, 404);
  } finally { await runtime.dispose(); }
});

test('workerd: concurrent requests cannot exceed ten accepted votes per IP in a rolling hour', async () => {
  const runtime = createRuntime();
  try {
    const db = await runtime.getD1Database('DB');
    await initialize(db);
    const responses = await Promise.all(Array.from({ length: 20 }, () => sendVote(runtime, randomUUID())));
    assert.equal(responses.filter(response => response.status === 200).length, 10);
    assert.equal(responses.filter(response => response.status === 429).length, 10);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM votes').first()).count, 10);
    assert.equal((await db.prepare('SELECT left_votes FROM totals').first()).left_votes, 10);
    const revisions = (await db.prepare('SELECT applied_revision FROM votes ORDER BY applied_revision').all()).results.map(row => row.applied_revision);
    assert.deepEqual(revisions, Array.from({ length: 10 }, (_, index) => index + 1));
    assert.equal((await sendVote(runtime, randomUUID(), { ip: '192.0.2.11' })).status, 200);
  } finally { await runtime.dispose(); }
});

test('workerd: late ACK retry uses ballot revision even after other votes commit', async () => {
  const runtime = createRuntime();
  try {
    const db = await runtime.getD1Database('DB');
    await initialize(db);
    const firstVoter = randomUUID();
    const first = await (await sendVote(runtime, firstVoter)).json();
    const worker = await runtime.getWorker();
    await worker.scheduled({ cron: '* * * * *' });
    const snapshot = await (await (await runtime.getR2Bucket('SNAPSHOTS')).get('results.json')).json();
    const second = await (await sendVote(runtime, randomUUID())).json();
    const retry = await (await sendVote(runtime, firstVoter)).json();
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(retry.revision, 1);
    assert.equal(snapshot.revision >= retry.revision, true, 'snapshot already includes this vote; UI must not add it again');
  } finally { await runtime.dispose(); }
});

test('workerd: oversized bodies and unknown routes fail without a vote', async () => {
  const runtime = createRuntime();
  try {
    const db = await runtime.getD1Database('DB');
    await initialize(db);
    const response = await runtime.dispatchFetch('https://api.example.com/vote', {
      method: 'POST', headers: { Origin: 'https://vote.example.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: 'x'.repeat(4097)
    });
    assert.equal(response.status, 413);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM votes').first()).count, 0);
  } finally { await runtime.dispose(); }
});
