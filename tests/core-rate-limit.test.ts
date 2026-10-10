import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type CoreDeps } from '../apps/core/app.ts';
import { DomainError } from '../packages/domain/policy.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { coreFetch } from '../packages/domain/core-http.ts';

const tokens = { owner: 'o'.repeat(64), engine: 'e'.repeat(64), audio: 'a'.repeat(64), bridge: 'b'.repeat(64) };
const principal = { characterId: 'lada', audienceId: 'demo-public' };
function harness() {
  let accesses = 0;
  const unused = async () => { throw new Error('unused'); };
  const deps: CoreDeps = {
    pool: { query: async () => { accesses++; return { rows: [], rowCount: 0 }; }, end: async () => {} },
    status: async () => { accesses++; return { paused: false }; }, search: unused, remember: unused,
    control: unused, ingest: unused, nextEvent: unused, recentConversation: unused, complete: unused, deferEvent: unused,
    enqueueSpeech: unused, claimSpeech: async () => null, speechState: unused, updateSpeech: unused
  };
  const app = buildApp({ principal, tokens, deps, allowSystemChatPublicDemo: false });
  return { app, deps, accesses: () => accesses };
}

test('role budget spans routes, rejects before DB work, ignores spoofed IP, and leaves audio polling available', async () => {
  const h = harness();
  try {
    for (let i = 0; i < 120; i++) {
      const r = await h.app.inject({ url: i % 2 ? '/owner/status' : '/owner/replies', headers: { authorization: `Bearer ${tokens.owner}` } });
      assert.equal(r.statusCode, 200);
    }
    const before = h.accesses();
    const limited = await h.app.inject({ url: '/owner/replies', headers: { authorization: `Bearer ${tokens.owner}`, 'x-forwarded-for': '8.8.8.8' } });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, 'rate_limit_exceeded');
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal(h.accesses(), before);
    assert.equal((await h.app.inject({ url: '/engine/status', headers: { authorization: `Bearer ${tokens.engine}` } })).statusCode, 200);
    for (let i = 0; i < 360; i++) {
      assert.equal((await h.app.inject({ method: 'POST', url: '/audio/claim', headers: { authorization: `Bearer ${tokens.audio}` } })).statusCode, 200);
    }
    assert.equal((await h.app.inject({ url: '/owner/replies', headers: { authorization: `Bearer ${tokens.bridge}` } })).statusCode, 401);
  } finally { await h.app.close(); }
});

test('admission failures are retryable 429 responses', async () => {
  for (const code of ['event_queue_full', 'author_rate_limit']) {
    const h = harness();
    h.deps.ingest = async () => { throw new DomainError(code); };
    // buildApp captures dependencies, so build after overriding ingest.
    const app = buildApp({ principal, tokens, deps: h.deps, allowSystemChatPublicDemo: false });
    try {
      const r = await app.inject({ method: 'POST', url: '/owner/events', headers: { authorization: `Bearer ${tokens.owner}` },
        payload: { source_key: 'test', author_id: 'test', text: 'hi' } });
      assert.equal(r.statusCode, 429);
      assert.equal(r.json().error, code);
      assert.equal(r.headers['retry-after'], '60');
    } finally { await app.close(); await h.app.close(); }
  }
});

test('updated MCP SDK works through the authenticated core and restricted HTTP client', async () => {
  const h = harness();
  const client = new Client({ name: 'security-test', version: '1' });
  try {
    const base = await h.app.listen({ host: '127.0.0.1', port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      fetch: coreFetch, requestInit: { headers: { Authorization: `Bearer ${tokens.engine}` } }
    }));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['agent_get_status', 'memory_propose', 'memory_search']);
    const result = await client.callTool({ name: 'agent_get_status', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: 'text', text: '{"paused":false}' }]);
  } finally { await client.close(); await h.app.close(); }
});
