import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../api/worker.js';

const schema = readFileSync(new URL('../api/schema.sql', import.meta.url), 'utf8');
const guard = readFileSync(new URL('../api/migrations/0003_ip_vote_guard.sql', import.meta.url), 'utf8');
const origin = 'https://ds-vs-ds.win';
const allow = { async limit() { return { success: true }; } };

function database(withGuard = true) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  if (withGuard) db.exec(guard);
  return db;
}
function ballot(db, ip, id = crypto.randomUUID(), choice = 'left') {
  return db.prepare('INSERT INTO votes (voter_id, choice, client_ip) VALUES (?, ?, ?) ON CONFLICT(voter_id) DO NOTHING').run(id, choice, ip);
}
function total(db) { return db.prepare('SELECT SUM(total) AS n FROM totals').get().n; }
function blocked(db, ip) { return db.prepare('SELECT * FROM ip_vote_blocks WHERE client_ip = ?').get(ip); }

// Real SQLite exercises the production trigger and transaction, including ignored inserts.
test('eleventh distinct ballot blocks an IP across both choices; duplicates consume no quota', () => {
  const db = database();
  try {
    const id = crypto.randomUUID();
    ballot(db, '192.0.2.1', id);
    for (let i = 0; i < 9; i++) ballot(db, '192.0.2.1', crypto.randomUUID(), 'right');
    for (let i = 0; i < 20; i++) ballot(db, '192.0.2.1', id, 'right');
    assert.equal(total(db), 10);
    assert.equal(blocked(db, '192.0.2.1'), undefined);
    assert.equal(ballot(db, '192.0.2.1').changes, 0);
    assert.equal(blocked(db, '192.0.2.1').votes_in_hour, 10);
    assert.equal(total(db), 10);
    db.prepare("UPDATE votes SET created_at = datetime('now', '-2 hours')").run();
    assert.equal(ballot(db, '192.0.2.1').changes, 0, 'ban persists after counting window');
    assert.equal(ballot(db, '192.0.2.2').changes, 1, 'another IP remains able to vote');
    assert.equal(total(db), 11);
  } finally { db.close(); }
});

test('rolling window expires individual votes rather than resetting on clock hours', () => {
  const db = database();
  try {
    for (let i = 0; i < 10; i++) ballot(db, '192.0.2.1');
    const oldest = db.prepare('SELECT voter_id FROM votes LIMIT 1').get().voter_id;
    db.prepare("UPDATE votes SET created_at = datetime('now', '-1 hour') WHERE voter_id = ?").run(oldest);
    assert.equal(ballot(db, '192.0.2.1').changes, 1, 'vote exactly an hour old is outside window');
    assert.equal(blocked(db, '192.0.2.1'), undefined);
    assert.equal(ballot(db, '192.0.2.1').changes, 0);
    assert.equal(total(db), 11);
  } finally { db.close(); }
});

test('migration blocks known excessive recent IPs and preserves all existing counts and unknown IPs', () => {
  const db = database(false);
  try {
    for (let i = 0; i < 11; i++) ballot(db, '192.0.2.1');
    for (let i = 0; i < 10; i++) ballot(db, '192.0.2.2');
    for (let i = 0; i < 12; i++) ballot(db, null);
    db.exec(guard);
    db.exec(guard); // Safe to reapply this additive migration only.
    assert.equal(blocked(db, '192.0.2.1').votes_in_hour, 11);
    assert.equal(blocked(db, '192.0.2.2'), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ip_vote_blocks').get().n, 1);
    assert.equal(total(db), 33);
  } finally { db.close(); }
});

test('simultaneous verified new identities cannot exceed ten; untrusted forwarded IP cannot bypass', async () => {
  const db = database();
  const original = globalThis.fetch;
  function prepare(sql, params = []) {
    return {
      bind(...values) { return prepare(sql, values); },
      run() { return /^SELECT/.test(sql) ? { results: db.prepare(sql).all(...params) } : { results: [], ...db.prepare(sql).run(...params) }; },
    };
  }
  const env = {
    ALLOWED_ORIGINS: [origin], TURNSTILE_SECRET_KEY: 'test-only',
    VOTE_LIMIT: allow, VOTE_GLOBAL_LIMIT: allow,
    DB: { prepare, async batch(statements) {
      db.exec('BEGIN');
      try { const results = statements.map(s => s.run()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } },
  };
  globalThis.fetch = async (_, options) => {
    assert.equal(options.body.get('remoteip'), '192.0.2.1');
    return Response.json({ success: true, hostname: 'ds-vs-ds.win', action: 'vote', cdata: options.body.get('response') });
  };
  try {
    const responses = await Promise.all(Array.from({ length: 25 }, (_, index) => {
      const id = crypto.randomUUID();
      return worker.fetch(new Request(`${origin}/api/vote`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Voter-ID': id, 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': `198.51.100.${index}` },
        body: JSON.stringify({ choice: index % 2 ? 'left' : 'right', token: id, client_ip: `198.51.100.${index}` }),
      }), env);
    }));
    assert.equal(responses.filter(r => r.status === 200).length, 10);
    assert.equal(responses.filter(r => r.status === 403).length, 15);
    for (const response of responses.filter(r => r.status === 403)) assert.equal((await response.json()).error, 'ip_blocked');
    assert.equal(total(db), 10);
    assert.deepEqual(db.prepare('SELECT DISTINCT client_ip FROM votes').all().map(r => r.client_ip), ['192.0.2.1']);
    assert.equal(blocked(db, '192.0.2.1').votes_in_hour, 10);
  } finally { globalThis.fetch = original; db.close(); }
});
