const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4096;

function json(body, status, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return Response.json(body, { status, headers });
}

async function readBody(request) {
  if (!request.body) throw new Error('invalid_body');
  const reader = request.body.getReader();
  let text = '';
  let length = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('body_too_large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

async function hashIp(ip, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(ip));
  return Array.from(new Uint8Array(signed), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verify(token, voterId, ip, env) {
  const response = await fetch(SITEVERIFY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('verification_unavailable');
  const result = await response.json();
  return result.success === true && result.hostname === env.TURNSTILE_HOSTNAME &&
    result.action === 'vote' && result.cdata === voterId;
}

async function vote(request, env) {
  const origin = request.headers.get('Origin');
  if (origin !== env.APP_ORIGIN) return json({ error: 'origin_not_allowed' }, 403);
  if (env.VOTING_ENABLED !== 'true' || !env.TURNSTILE_SECRET || !env.IP_HASH_SECRET) {
    return json({ error: 'voting_unavailable' }, 503, origin);
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    return json({ error: 'json_required' }, 415, origin);
  }
  let body;
  try { body = await readBody(request); }
  catch (error) { return json({ error: error.message === 'body_too_large' ? 'body_too_large' : 'invalid_body' }, error.message === 'body_too_large' ? 413 : 400, origin); }
  if (!body || !UUID.test(body.voterId ?? '') || !['left', 'right'].includes(body.choice) ||
      typeof body.token !== 'string' || body.token.length === 0 || body.token.length > 2048) {
    return json({ error: 'invalid_vote' }, 400, origin);
  }
  // Trust only Cloudflare's edge-supplied address. Do not accept X-Forwarded-For as fallback.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return json({ error: 'client_address_unavailable' }, 503, origin);
  const db = env.DB.withSession('first-primary');
  const previous = await db.prepare('SELECT choice, applied_revision FROM votes WHERE voter_id = ?').bind(body.voterId).first();
  if (previous) {
    return json({ accepted: true, duplicate: true, choice: previous.choice, revision: previous.applied_revision }, 200, origin);
  }
  const ipHash = await hashIp(ip, env.IP_HASH_SECRET);
  const limit = await db.prepare('SELECT COUNT(*) AS count FROM votes WHERE ip_hash = ? AND created_at >= unixepoch() - 3600').bind(ipHash).first();
  if (limit.count >= 10) return json({ error: 'ip_hourly_limit' }, 429, origin);
  try {
    if (!await verify(body.token, body.voterId, ip, env)) return json({ error: 'verification_failed' }, 403, origin);
  } catch {
    return json({ error: 'verification_unavailable' }, 503, origin);
  }
  try {
    // One atomic insert: dedupe, rolling IP trigger and totals trigger commit together.
    const result = await db.prepare(`INSERT INTO votes(voter_id, choice, ip_hash, applied_revision)
      SELECT ?, ?, ?, revision + 1 FROM totals WHERE id = 1
      AND NOT EXISTS (SELECT 1 FROM votes WHERE voter_id = ?)`)
      .bind(body.voterId, body.choice, ipHash, body.voterId).run();
    const saved = await db.prepare('SELECT choice, applied_revision FROM votes WHERE voter_id = ?').bind(body.voterId).first();
    if (!saved) throw new Error('vote_not_persisted');
    return json({ accepted: true, duplicate: result.meta.changes === 0, choice: saved.choice, revision: saved.applied_revision }, 200, origin);
  } catch (error) {
    if (String(error).includes('ip_hourly_limit')) return json({ error: 'ip_hourly_limit' }, 429, origin);
    throw error;
  }
}

export async function publishSnapshot(env) {
  if (env.PUBLISH_ENABLED !== 'true') return { published: false, reason: 'disabled' };
  // Capture the etag BEFORE reading D1. Never reuse an old body after a CAS failure.
  const previous = await env.SNAPSHOTS.head('results.json');
  const db = env.DB.withSession('first-primary');
  const row = await db.prepare(`SELECT left_votes AS leftVotes, right_votes AS rightVotes,
    revision, unixepoch() AS capturedAt FROM totals WHERE id = 1`).first();
  if (!row) throw new Error('totals_not_initialized');
  const snapshot = { schemaVersion: 1, ...row };
  const condition = new Headers(previous ? { 'If-Match': previous.httpEtag } : { 'If-None-Match': '*' });
  const written = await env.SNAPSHOTS.put('results.json', JSON.stringify(snapshot), {
    onlyIf: condition,
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=1, s-maxage=10' },
    customMetadata: { revision: String(row.revision) }
  });
  return written ? { published: true, revision: row.revision } : { published: false, reason: 'concurrent_publish' };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path !== '/vote') return json({ error: 'not_found' }, 404);
    if (request.method === 'OPTIONS' && request.headers.get('Origin') === env.APP_ORIGIN) {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': env.APP_ORIGIN,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
        Vary: 'Origin'
      } });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    try { return await vote(request, env); }
    catch {
      console.error(JSON.stringify({ event: 'vote_failed' }));
      return json({ error: 'service_unavailable' }, 503, request.headers.get('Origin') === env.APP_ORIGIN ? env.APP_ORIGIN : undefined);
    }
  },
  async scheduled(controller, env) {
    try {
      const result = await publishSnapshot(env);
      console.log(JSON.stringify({ event: 'snapshot_publish', ...result }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'snapshot_publish_failed' }));
      throw error;
    }
  }
};
