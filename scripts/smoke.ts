import { coreBaseUrl, coreFetch } from '../packages/domain/core-http.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base=coreBaseUrl(process.env.CORE_URL ?? 'http://localhost:3000');
const engine=(await readFile(process.env.ENGINE_TOKEN_FILE ?? 'secrets/engine_token','utf8')).trim();
const owner=(await readFile(process.env.OWNER_TOKEN_FILE ?? 'secrets/owner_token','utf8')).trim();
async function api(path: string, token: string, body?: unknown) {
  const r=await coreFetch(base+path,{ headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    method:body?'POST':'GET', body:body?JSON.stringify(body):undefined });
  assert.equal(r.ok,true,`HTTP ${r.status}: ${path}`); return r.json();
}
const client=new Client({name:'harness-smoke',version:'0.1.0'});
try {
  const denied=await coreFetch(base+'/owner/status',{headers:{Authorization:`Bearer ${engine}`}});
  assert.equal(denied.status,401);
  await api('/owner/resume',owner,{});
  const source_key=randomUUID();
  const event={source_key,author_id:'test-player',text:'Мы вместе построили мост. Запомни это публичное событие.'};
  assert.equal((await api('/owner/events',owner,event)).inserted,true);
  assert.equal((await api('/owner/events',owner,event)).inserted,false);
  const input=await api('/engine/input',engine);
  assert.ok(input.event);
  assert.equal((await api('/engine/input',engine)).event,null,'Active lease prevents a second claim');
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{fetch:coreFetch,requestInit:{headers:{Authorization:`Bearer ${engine}`}}}));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['agent_action_status','agent_get_status','agent_observe','agent_turn','agent_walk','memory_propose','memory_search']);
  const args={text:`public-${source_key}`,invocation_id:randomUUID(),epoch:input.character.epoch};
  const first=await client.callTool({name:'memory_propose',arguments:args});
  const second=await client.callTool({name:'memory_propose',arguments:args});
  function value(result: typeof first) {
    const content=result.content as Array<{type:string;text?:string}>;
    assert.equal(content[0]?.type,'text');
    return JSON.parse(content[0].text!);
  }
  assert.deepEqual(value(first),value(second),'Replay must return original operation');
  const conflict=await client.callTool({name:'memory_propose',arguments:{...args,text:'different'}});
  assert.equal(conflict.isError,true);
  const notes=await client.callTool({name:'memory_search',arguments:{query:source_key}});
  assert.ok(JSON.stringify(notes).includes(source_key));
  await api('/owner/pause',owner,{});
  const stale=await client.callTool({name:'memory_propose',arguments:{...args,invocation_id:randomUUID()}});
  assert.equal(stale.isError,true);
  await api('/owner/resume',owner,{});
  const expired=await coreFetch(base+'/engine/complete',{method:'POST',headers:{Authorization:`Bearer ${engine}`,'Content-Type':'application/json'},
    body:JSON.stringify({event_id:input.event.id,text:'stale reply',epoch:input.character.epoch})});
  assert.equal(expired.status,409,'Old epoch cannot save a reply after resume');
  const retry=await api('/engine/input',engine);
  assert.ok(retry.event);
  await api('/engine/complete',engine,{event_id:retry.event.id,text:'Synthetic smoke reply',epoch:retry.character.epoch});
  const replies=await api('/owner/replies',owner);
  assert.ok(replies.some((r: {id:string;reply:string})=>r.id===retry.event.id && r.reply==='Synthetic smoke reply'));
  console.log('MCP + PostgreSQL smoke passed. No LLM or external accounts used.');
} finally {await client.close();}
