import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function initialize(database) {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const statement of sql.split(/^-- statement\s*$/m).slice(1)) await database.prepare(statement).run();
}

export function createRuntime(persistPath) {
  const used = new Set();
  const options = convertV4MiniflareOptions({
    modules: true,
    scriptPath: fileURLToPath(new URL('../src/worker.js', import.meta.url)),
    compatibilityDate: '2026-10-04',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'local-template-db' },
    r2Buckets: ['SNAPSHOTS'],
    bindings: {
      VOTING_ENABLED: 'true', PUBLISH_ENABLED: 'true',
      APP_ORIGIN: 'https://vote.example.com', TURNSTILE_HOSTNAME: 'vote.example.com',
      TURNSTILE_SECRET: 'local-mocked-service-only', IP_HASH_SECRET: 'local-test-hash-secret-only'
    },
    // Every outbound request is intercepted locally. There is no real Siteverify call.
    outboundService: async request => {
      if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected outbound request');
      const form = new URLSearchParams(await request.text());
      const token = form.get('response') ?? '';
      const [mode, voterId] = token.split(':');
      const replayed = used.has(token);
      used.add(token);
      return Response.json({
        success: !replayed && mode !== 'invalid',
        hostname: mode === 'wrong-host' ? 'other.example.com' : 'vote.example.com',
        action: mode === 'wrong-action' ? 'login' : 'vote',
        cdata: voterId,
        'error-codes': replayed ? ['timeout-or-duplicate'] : []
      });
    }
  });
  options.resourcePersistencePath = persistPath;
  const runtime = new Miniflare(options);
  return runtime;
}

export function sendVote(runtime, voterId, options = {}) {
  return runtime.dispatchFetch('https://api.example.com/vote', {
    method: 'POST',
    headers: { Origin: options.origin ?? 'https://vote.example.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': options.ip ?? '192.0.2.10' },
    body: JSON.stringify({ voterId, choice: options.choice ?? 'left', token: options.token ?? `valid:${voterId}` })
  });
}
