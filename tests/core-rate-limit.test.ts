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
    enqueueSpeech: unused, claimSpeech: async () => null, speechState: unused, updateSpeech: unused,
    enqueueClientAction: unused, clientActionStatus: unused, clientActionLease: unused,
    claimClientAction: async () => null, finishClientAction: unused, saveWorldObservation: unused,
    latestWorldObservation: unused, cancelClientActions: async () => ({ cancelled: true })
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
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['agent_action_status', 'agent_get_status', 'agent_observe', 'agent_turn', 'agent_walk', 'memory_propose', 'memory_search', 'memory_social_list', 'memory_stage_delta']);
    const result = await client.callTool({ name: 'agent_get_status', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: 'text', text: '{"paused":false}' }]);
  } finally { await client.close(); await h.app.close(); }
});

test('MCP stage and obligation retrieval use trusted event/epoch headers',async()=>{
  const calls:any[]=[];
  const deps:CoreDeps={
    pool:{query:async()=>({rows:[],rowCount:0}),end:async()=>{}},status:async()=>({paused:false}),search:async()=>[],remember:async()=>({}),
    control:async()=>({}),ingest:async()=>({inserted:true,event_id:null}),nextEvent:async()=>null,recentConversation:async()=>[],complete:async()=>({}),deferEvent:async()=>({}),
    stageMemory:async(...args:any[])=>{calls.push(['stage',...args]);return {staged:true,stage_version:1};},
    socialCommitmentPage:async(...args:any[])=>{calls.push(['list',...args]);return {items:[],total:0,offset:0,limit:5};},
    enqueueSpeech:async()=>({}),claimSpeech:async()=>null,speechState:async()=>null,updateSpeech:async()=>({}), enqueueClientAction:async()=>({}),clientActionStatus:async()=>({}),clientActionLease:async()=>({}),claimClientAction:async()=>null,finishClientAction:async()=>({}),saveWorldObservation:async()=>({}),latestWorldObservation:async()=>null,cancelClientActions:async()=>({})
  };
  const app=buildApp({principal,tokens,deps,allowSystemChatPublicDemo:false});
  const client=new Client({name:'scope-test',version:'1'});
  const eventId='11111111-1111-4111-8111-111111111111';
  try{
    const base=await app.listen({host:'127.0.0.1',port:0});
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{fetch:coreFetch,requestInit:{headers:{Authorization:`Bearer ${tokens.engine}`,'X-Harness-Event':eventId,'X-Harness-Epoch':'17'}}}));
    const listed=await client.callTool({name:'memory_social_list',arguments:{limit:5,offset:10}});
    assert.equal(listed.isError,undefined);
    const staged=await client.callTool({name:'memory_stage_delta',arguments:{invocation_id:'model-chosen',proposal:{person:{display_name:'Alex'},facts:[],relationships:[],commitments:[],working_state:null}}});
    assert.equal(staged.isError,undefined);
    assert.equal(calls[0][0],'list');
    assert.equal(calls[0][2],eventId);assert.equal(calls[0][3],17);assert.equal(calls[0][4],5);assert.equal(calls[0][5],10);
    assert.equal(calls[1][0],'stage');assert.equal(calls[1][2],eventId);assert.equal(calls[1][3],17);assert.equal(calls[1][4],'model-chosen');
    const unscoped=new Client({name:'scope-test',version:'1'});
    try{
      await unscoped.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{fetch:coreFetch,requestInit:{headers:{Authorization:`Bearer ${tokens.engine}`}}}));
      const denied=await unscoped.callTool({name:'memory_stage_delta',arguments:{invocation_id:'x',proposal:{facts:[{content:'x',confidence:0.5,epistemic_status:'inferred'}]}}});
      assert.equal(denied.isError,true);
    }finally{await unscoped.close();}
  }finally{await client.close();await app.close();}
});

test('bridge polling leaves event admission available and keeps its own bounded budget', async () => {
  const h = harness();
  let ingested = 0;
  h.deps.ingest = async () => { ingested++; return { inserted: true, event_id: null }; };
  const app = buildApp({ principal, tokens, deps: h.deps, allowSystemChatPublicDemo: false });
  const headers = { authorization: `Bearer ${tokens.bridge}` };
  try {
    // 400 action polls + 60 reply polls + 240 lease polls fit in one minute.
    for (let i = 0; i < 700; i++) {
      const r = await app.inject({ method: 'POST', url: '/bridge/actions/claim', headers, payload: {} });
      assert.equal(r.statusCode, 200);
    }
    for (let i = 0; i < 180; i++) {
      const r = await app.inject({ method: 'POST', url: '/bridge/events', headers, payload: {
        source_key: `minecraft:11111111-1111-4111-8111-111111111111:${i}`,
        author_id: '11111111-1111-4111-8111-111111111111',
        author_provenance: 'fabric_profile_context', text: 'hi'
      } });
      assert.equal(r.statusCode, 200);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/bridge/events', headers, payload: {} })).statusCode, 429);
    assert.equal(ingested, 180);
    for (let i = 700; i < 900; i++) {
      assert.equal((await app.inject({ method: 'POST', url: '/bridge/actions/claim', headers, payload: {} })).statusCode, 200);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/bridge/actions/claim', headers, payload: {} })).statusCode, 429);
  } finally { await app.close(); await h.app.close(); }
});
