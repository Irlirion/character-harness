import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {TelegramStore} from '../packages/storage/telegram.ts';
import {RuntimeStore} from '../packages/storage/runtime.ts';
import {RuntimeAuthorizationStore} from '../packages/storage/runtime-authorization.ts';
import {RuntimePolicyGate} from '../packages/runtime/gate.ts';
import {RuntimeAudienceGate} from '../packages/runtime/audience-gate.ts';
import {testProfile,allowTestReviewer,testIdentity} from './fixtures/runtime-policy.ts';

const p={characterId:'lada',audienceId:'demo-public'};
test('Telegram private runtime controls and scoped delivery',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='telegram_runtime_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});let db:pg.Pool|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);db=new pg.Pool({connectionString:url.toString()});const pool=db;
  for(const f of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const runtime=new RuntimeStore(pool),auth=new RuntimeAuthorizationStore(pool),telegram=new TelegramStore(pool,'lada',runtime);
  const gate=new RuntimeAudienceGate(new RuntimePolicyGate(runtime,auth,allowTestReviewer),pool);
  let owner=randomUUID(),uid=0,b:any,profile=testProfile();
  const reset=async()=>{
   await pool.query('TRUNCATE characters CASCADE');await pool.query("INSERT INTO characters(id,name,persona) VALUES('lada','Lada','A fictional character')");
   owner=randomUUID();uid=0;await telegram.register('99','LadaBot');await telegram.polling('99',owner);await telegram.accountState('99','connected',owner);b=await telegram.bind('99','8','private',true);profile=testProfile();await auth.installProfile(p,profile);
  };
  const message=(text:string,chat=8,kind='private',author=8)=>({update_id:++uid,message:{message_id:uid,date:Math.floor(Date.now()/1000),chat:{id:chat,type:kind},from:{id:author,is_bot:false},text}});
  const command=async(text:string)=>telegram.ingest('99',owner,[message(text)]);
  const activities=async()=>runtime.list({...p,audienceId:b.audience_id});
  const clearOutbox=()=>pool.query("UPDATE telegram_outbox SET state='sent' WHERE state IN ('pending','retry_wait')");
  const claim=async()=>{const r=await gate.claim(p,{request_id:randomUUID(),...testIdentity});assert.ok(r.work);return r.work;};
  const lease=(w:any)=>({turn_id:w.turn.id,epoch:w.turn.epoch,lease_token:w.turn.lease_token});
  const finish=async(w:any,decision:any,checkpoint='Safe checkpoint')=>{
   await gate.start(p,{...lease(w),grant_id:w.authorization.id,input_hash:w.authorization.input_hash,...testIdentity});
   return gate.decide(p,{...lease(w),invocation_id:randomUUID(),expected_version:w.activity.version,checkpoint,decision});
  };
  await t.test('private binding alone is not owner authority; groups and other senders cannot control tasks',async()=>{
   await reset();await command('/task Before explicit permission');assert.equal((await activities()).length,0);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_outbox')).rows[0].n,0);
   await telegram.runtimeControl(b.id,true);const group=await telegram.bind('99','-42','group',true);
   await assert.rejects(telegram.runtimeControl(group.id,true),{code:'private_binding_required'});
   await telegram.ingest('99',owner,[message('/task Spoofed',8,'private',9),message('/task Group',-42,'supergroup')]);
   assert.equal((await activities()).length,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM social_events')).rows[0].n,0);
   await command('/task@LadaBot Safe private plan');assert.equal((await activities()).length,1);
  });
  await t.test('command effects, message dedup, offset and receipt share one transaction',async()=>{
   await reset();await telegram.runtimeControl(b.id,true);const update=message('/task Safe private plan');await telegram.ingest('99',owner,[update]);await telegram.ingest('99',owner,[update]);
   await telegram.ingest('99',owner,[{...update,update_id:++uid}]);
   const [a]=await activities();assert.equal((await activities()).length,1);assert.equal(a.origin,'owner');assert.equal((await runtime.list(p)).length,0);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_outbox')).rows[0].n,1);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM social_events WHERE NOT processed')).rows[0].n,0);
   const job=await telegram.claim('99',owner);assert.ok(job);assert.equal(job.chat_id,'8');assert.ok(job.text.includes(a.id));await telegram.delivered(job.id,job.claim_id,'sent','500');
   await command('/cancel '+a.id);assert.equal((await activities())[0].status,'cancelled');
  });
  await t.test('private activity is consumed by engine; question, answer and result stay in the same audience',async()=>{
   await reset();await telegram.runtimeControl(b.id,true);await command('/task Make a safe plan and ask about size');await clearOutbox();
   const first=await claim();assert.equal(first.audience_id,b.audience_id);assert.equal(first.model_input.audience_id,b.audience_id);
   await finish(first,{action:'request_input',question:'Какой размер?'},'Need a size');
   await command('/status');const question=await telegram.claim('99',owner);assert.ok(question);assert.ok(question.text.includes('Какой размер?'));assert.equal((await pool.query('SELECT runtime_activity_id FROM telegram_outbox WHERE id=$1',[question.id])).rows[0].runtime_activity_id,first.activity.id);await telegram.delivered(question.id,question.claim_id,'sent','501');
   await command('/answer 10 на 10');await clearOutbox();const second=await claim();assert.equal(second.model_input.activity.input_reply,'10 на 10');assert.equal(second.checkpoint,'Need a size');
   await finish(second,{action:'complete',summary:'Безопасный план готов'},'Три безопасных шага');
   await command('/result');const result=await telegram.claim('99',owner);assert.ok(result);assert.ok(result.text.includes('Безопасный план готов'));assert.equal((await pool.query('SELECT runtime_turn_id FROM telegram_outbox WHERE id=$1',[result.id])).rows[0].runtime_turn_id,second.turn.id);
   assert.equal((await runtime.list(p)).length,0);assert.equal((await activities())[0].status,'completed');
  });
  await t.test('policy change and payload tampering revoke result delivery',async()=>{
   await reset();await telegram.runtimeControl(b.id,true);await command('/task Make a plan');await clearOutbox();const work=await claim();await finish(work,{action:'complete',summary:'Safe result'});
   await command('/result');await auth.installProfile(p,testProfile({version:'new.v2'}));assert.equal(await telegram.claim('99',owner),null);
   assert.equal((await pool.query("SELECT state FROM telegram_outbox WHERE runtime_turn_id=$1",[work.turn.id])).rows[0].state,'cancelled');
   await auth.installProfile(p,profile);await command('/result');await pool.query("UPDATE telegram_outbox SET text='Tampered' WHERE state='pending'");assert.equal(await telegram.claim('99',owner),null);
  });
  await t.test('binding revocation fences work; accounting remains scoped and old leases cannot revive',async()=>{
   await reset();await telegram.runtimeControl(b.id,true);await command('/task Make a plan');const work=await claim();
   await gate.start(p,{...lease(work),grant_id:work.authorization.id,input_hash:work.authorization.input_hash,...testIdentity});
   await telegram.runtimeControl(b.id,false);await assert.rejects(gate.lease(p,lease(work)),{code:'runtime_scope_denied'});
   await gate.usage(p,{...lease(work),total_tokens:null,source:'codex_notification'});
   await telegram.runtimeControl(b.id,true);assert.equal((await gate.lease(p,lease(work))).valid,false);
   const foreign={characterId:'other',audienceId:b.audience_id};await assert.rejects(gate.start(foreign,{...lease(work),grant_id:work.authorization.id,input_hash:work.authorization.input_hash,...testIdentity}),{code:'runtime_scope_denied'});
  });
  await t.test('foreign audience IDs never expose tasks or results',async()=>{
   await reset();await telegram.runtimeControl(b.id,true);
   await pool.query("INSERT INTO characters(id,name,persona) VALUES('other','Other','Other')");const foreign=await runtime.assign({characterId:'other',audienceId:'secret'},{invocation_id:'foreign',objective:'Private objective'});
   await command('/status '+foreign.id);const job=await telegram.claim('99',owner);assert.ok(job);assert.equal(job.text,'Задача не найдена в этом чате.');
   assert.ok(!job.text.includes('Private objective'));
  });
  await t.test('late outbox failure rolls back activity creation and update acknowledgment',async()=>{
   await reset();await telegram.runtimeControl(b.id,true);
   await pool.query("INSERT INTO social_events(id,character_id,audience_id,source_key,author_id,text) SELECT gen_random_uuid(),'lada','demo-public','backlog:'||n,'other','safe' FROM generate_series(1,100) n");
   const u=message('/task Retry transaction');await assert.rejects(telegram.ingest('99',owner,[u]),{code:'event_queue_full'});
   assert.equal((await activities()).length,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_updates')).rows[0].n,0);
   assert.equal((await telegram.polling('99',owner)).offset,'0');await pool.query('DELETE FROM social_events');await telegram.ingest('99',owner,[u]);assert.equal((await activities()).length,1);
  });
  await t.test('command processing is bounded by the existing per-minute private input limit',async()=>{
   await reset();await telegram.runtimeControl(b.id,true);for(let i=0;i<11;i++)await command('/task Safe plan '+i);
   assert.equal((await activities()).length,10);assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_outbox')).rows[0].n,10);
  });
 }finally{await db?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
