import { RuntimePolicyGate } from '../packages/runtime/gate.ts';
import { RuntimeAuthorizationStore } from '../packages/storage/runtime-authorization.ts';
import { testProfile, allowTestReviewer, testIdentity } from './fixtures/runtime-policy.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { RuntimeStore } from '../packages/storage/runtime.ts';
import { RuntimeConsumer, type RuntimeApi } from '../packages/runtime/consumer.ts';
import { runPiPlanning } from '../packages/runtime/pi-runner.ts';
import { runCodexPlanning } from '../packages/runtime/codex-runner.ts';
import { CodexRpc } from '../packages/codex/rpc.ts';
import { fileURLToPath } from 'node:url';
import { runtimeApp, runtimeTokens, runtimePrincipal as p } from './fixtures/runtime-app.ts';

test('runtime engine HTTP + database integration, without external models', {skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='runtime_engine_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 let pool:pg.Pool|undefined;
 let legacyPool:pg.Pool|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);
  pool=new pg.Pool({connectionString:url.toString()});const db=pool;
  for(const f of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.query(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));
  await db.query("INSERT INTO characters(id,name,persona) VALUES('lada','Lada','Persona')");
  process.env.DATABASE_URL=url.toString();
  const legacy=await import('../packages/storage/db.ts');legacyPool=legacy.pool;
  const actions=await import('../packages/storage/actions.ts');
  const store=new RuntimeStore(db);const auth=new RuntimeAuthorizationStore(db);
  await auth.installProfile(p,testProfile({version:'test.pi',engine:'pi'}));
  const app=runtimeApp({runtime:store,runtimeEngine:store,runtimePolicy:new RuntimePolicyGate(store,auth,allowTestReviewer)},
    {pool:db,status:legacy.status,nextEvent:legacy.nextEvent,search:legacy.search,complete:legacy.complete,remember:legacy.remember});
  const headers={authorization:`Bearer ${runtimeTokens.engine}`};
  let loseCommit=false;const receiptPayloads:unknown[]=[];
  const api:RuntimeApi=async(path,body)=>{
   const r=await app.inject({method:'POST',url:path,headers,payload:body as any});
   if(r.statusCode!==200)throw new Error(r.json().error);
   if(path==='/engine/work_decision'){
    receiptPayloads.push(body);
    if(loseCommit){loseCommit=false;throw new Error('synthetic_response_loss');}
   }
   return r.json();
  };
  try{
   await t.test('default app policy cannot claim or charge a turn even with engine routes present',async()=>{
    const a=await store.assign(p,{invocation_id:'first',objective:'Prepare the next steps',max_turns:10});
    const blocked=runtimeApp({runtime:store,runtimeEngine:store},{status:legacy.status});
    try{
     const response=await blocked.inject({method:'POST',url:'/engine/next_work',headers,payload:{request_id:'blocked'}});
     assert.equal(response.json().reason,'runtime_policy_blocked');
     assert.equal((await store.inspect(p,a.id)).activity.turns_used,0);
     assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_turns')).rows[0].n,0);
    }finally{await blocked.close();}
   });

   const activity=(await store.list(p))[0];
   await t.test('Pi saves a checkpoint, sleeps, and an unrelated social reply leaves the activity waiting',async()=>{
    let prompts=0;loseCommit=true;
    const consumer=new RuntimeConsumer(api,{engine:'pi',model:'model'});
    await consumer.tick((input,persona,signal,onUsage)=>runPiPlanning(async(_system,tools)=>({
     prompt:async()=>{
      prompts++;assert.equal(input.activity.objective,activity.objective);
      await tools[0].execute('decision',{checkpoint:'Plan: inspect resources next',decision:{action:'wait_until',at:new Date(Date.now()+180000).toISOString()}},signal,undefined,{} as any);
     },stats:()=>123,abort:async()=>{},dispose:()=>{},
    }),input,persona,signal,onUsage),new AbortController().signal);
    assert.equal(prompts,1);assert.equal(receiptPayloads.length,2);assert.deepEqual(receiptPayloads[0],receiptPayloads[1]);
    const saved=await store.inspect(p,activity.id);assert.equal(saved.activity.status,'waiting_time');assert.equal(saved.checkpoint.state,'Plan: inspect resources next');
    assert.equal((await db.query('SELECT observed_tokens FROM runtime_model_grants ORDER BY created_at LIMIT 1')).rows[0].observed_tokens,'123');
    await legacy.ingest(p,{source_key:'owner:test',author_id:'participant',text:'Hello',author_provenance:'owner_input',author_trust:'unverified'});
    const event=(await app.inject({url:'/engine/input',headers})).json();assert.ok(event.event);
    const finished=await app.inject({method:'POST',url:'/engine/complete',headers,payload:{event_id:event.event.id,epoch:event.character.epoch,decision:'silent'}});
    assert.equal(finished.statusCode,200);
    assert.equal((await store.inspect(p,activity.id)).activity.status,'waiting_time');
    assert.equal((await consumer.tick(async()=>{throw new Error('idle must not invoke model');},new AbortController().signal)).worked,false);
   });

   await t.test('Codex resumes the stored checkpoint through real stdio; only lifecycle state changes',async()=>{
    await auth.installProfile(p,testProfile({version:'test.codex'}));
    await db.query("UPDATE runtime_wakeups SET available_at=clock_timestamp()-interval '1 second' WHERE state='pending'");
    const fixture=fileURLToPath(new URL('./fixtures/codex-runtime-child.mjs',import.meta.url));
    const rpc=new CodexRpc(process.execPath,process.cwd(),'/tmp/harness-runtime-test',[fixture]);
    try{
     await rpc.initialize();
     await new RuntimeConsumer(api,testIdentity).tick(async(input,persona,signal,onUsage)=>{
      assert.equal(input.checkpoint,'Plan: inspect resources next');
      return runCodexPlanning(rpc,'/isolated','model',input,persona,signal,onUsage);
     },new AbortController().signal);
    }finally{rpc.close();}
    const saved=await store.inspect(p,activity.id);
    assert.equal(saved.activity.status,'ready');assert.equal(saved.activity.turns_used,2);assert.equal(saved.checkpoint.state,'Plan from fake Codex');
    assert.equal((await db.query('SELECT observed_tokens FROM runtime_model_grants ORDER BY created_at DESC LIMIT 1')).rows[0].observed_tokens,'222');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM replies')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM client_actions')).rows[0].n,0);
   });

   await t.test('runtime leases cannot authorize legacy MCP, memory writes or movement',async()=>{
    await db.query("UPDATE runtime_wakeups SET available_at=clock_timestamp()-interval '1 second' WHERE state='pending'");
    const claim:any=await api('/engine/next_work',{request_id:'isolation',...testIdentity});const w=claim.work;assert.ok(w);
    const l={turn_id:w.turn.id,epoch:w.turn.epoch,lease_token:w.turn.lease_token};
    assert.equal((await api('/engine/work_lease',l) as any).valid,true);
    assert.equal((await store.lease({...p,audienceId:'private'},l)).valid,false);
    assert.equal((await store.lease(p,{...l,lease_token:randomUUID()})).valid,false);
    await assert.rejects(legacy.remember(p,'Must not save','forbidden',w.turn.epoch),{code:'runtime_tools_disabled'});
    await assert.rejects(actions.enqueueClientAction(p,'forbidden','turn',{yaw_degrees:30},0,w.turn.epoch),{code:'runtime_tools_disabled'});
    const mcp=await app.inject({method:'POST',url:'/mcp',headers,payload:{jsonrpc:'2.0',id:1,method:'tools/list'}});
    assert.equal(mcp.statusCode,409);assert.equal(mcp.json().error,'runtime_tools_disabled');
    await legacy.control(p,true);
    assert.equal((await store.lease(p,l)).valid,false);
    assert.equal((await store.inspect(p,activity.id)).activity.status,'ready');
    await legacy.control(p,false);
    assert.equal((await store.lease(p,l)).valid,false);
    await auth.installProfile(p,testProfile({version:'test.disabled',enabled:false}));
    const before=(await store.inspect(p,activity.id)).activity.turns_used;
    assert.equal((await api('/engine/next_work',{request_id:'policy-revoked',...testIdentity}) as any).work,null);
    assert.equal((await store.inspect(p,activity.id)).activity.turns_used,before);
    const ownerHeaders={authorization:`Bearer ${runtimeTokens.owner}`};
    const overview=await app.inject({url:'/owner/runtime-policy',headers:ownerHeaders});
    assert.equal(overview.statusCode,200);assert.equal(overview.headers['cache-control'],'no-store');
    assert.equal(overview.json().profile.enabled,false);assert.ok(overview.json().resources.dispatches>=3);
    assert.ok(!overview.body.includes('lease_token')&&!overview.body.includes('approved_input'));
    assert.equal((await app.inject({url:'/owner/runtime-policy',headers})).statusCode,401);
   });
  }finally{await app.close();}
 }finally{
  await legacyPool?.end();await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
 }
});
