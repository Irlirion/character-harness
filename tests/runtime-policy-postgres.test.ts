import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { RuntimeStore } from '../packages/storage/runtime.ts';
import { RuntimeAuthorizationStore } from '../packages/storage/runtime-authorization.ts';
import { RuntimePolicyGate } from '../packages/runtime/gate.ts';
import { testProfile,allowTestReviewer,testIdentity } from './fixtures/runtime-policy.ts';
import { createProcessReviewer } from '../packages/runtime/reviewer.ts';
import { fingerprint } from '../packages/runtime/policy.ts';
import { fileURLToPath } from 'node:url';
import type { ContentReviewer } from '../packages/runtime/policy.ts';

const p={characterId:'lada',audienceId:'demo'};
test('durable runtime policy bindings and resource accounting',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='runtime_policy_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});let pool:pg.Pool|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);
  pool=new pg.Pool({connectionString:url.toString(),max:8});const db=pool;
  for(const f of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.query(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const runtime=new RuntimeStore(db),auth=new RuntimeAuthorizationStore(db);
  const reset=async()=>{await db.query('TRUNCATE characters CASCADE');await db.query("INSERT INTO characters(id,name,persona) VALUES('lada','Lada','Persona')");};
  const assign=(objective='Prepare a plan',key=randomUUID())=>runtime.assign(p,{invocation_id:key,objective});
  const claim=(gate:RuntimePolicyGate,id=randomUUID())=>gate.claim(p,{request_id:id,...testIdentity});
  const lease=(w:any)=>({turn_id:w.turn.id,epoch:w.turn.epoch,lease_token:w.turn.lease_token});
  const start=(gate:RuntimePolicyGate,w:any)=>gate.start(p,{...lease(w),grant_id:w.authorization.id,input_hash:w.authorization.input_hash,...testIdentity});
  const decide=(w:any)=>({...lease(w),invocation_id:'decision:'+w.turn.id,expected_version:w.activity.version,checkpoint:'Safe plan',decision:{action:'continue' as const}});
  const gate=(reviewer?:ContentReviewer)=>new RuntimePolicyGate(runtime,auth,reviewer,10);
  const expire=async()=>{await db.query("UPDATE runtime_turns SET lease_until=clock_timestamp()-interval '1 second'");await db.query("UPDATE characters SET lease_until=clock_timestamp()-interval '1 second'");};

  await reset();
  await t.test('missing eligibility, expired profile and absent reviewer never create a model grant',async()=>{
   await assign();assert.equal((await claim(gate(allowTestReviewer))).reason,'runtime_policy_blocked');
   for(const [version,change] of [['unverified',{provider_eligible:false}],['expired',{reviewed_at:new Date(Date.now()-20000).toISOString(),expires_at:new Date(Date.now()-10000).toISOString()}]] as const){
    await auth.installProfile(p,testProfile({version,...change}));assert.equal((await claim(gate(allowTestReviewer))).work,null);
   }
   await auth.installProfile(p,testProfile());assert.equal((await claim(gate())).reason,'reviewer_unavailable');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_model_grants')).rows[0].n,0);
   assert.equal((await runtime.list(p))[0].blocked_reason,'reviewer_unavailable');
  });

  await reset();
  await t.test('secrets are held before review without spending turns; unrelated work can proceed',async()=>{
   await auth.installProfile(p,testProfile());let reviews=0;
   const reviewer:ContentReviewer=async(r,s)=>{reviews++;return allowTestReviewer(r,s);};
   const a=await assign('sk-proj-'+'A'.repeat(32));
   assert.equal((await claim(gate(reviewer))).reason,'secret_detected');assert.equal(reviews,0);
   assert.equal((await runtime.inspect(p,a.id)).activity.turns_used,0);
   assert.equal((await claim(gate(reviewer))).work,null);assert.equal(reviews,0);
   const other=await assign('Prepare an unrelated plan');const w=(await claim(gate(reviewer))).work!;
   assert.equal(w.activity.id,other.id);assert.equal(reviews,1);
   assert.ok(!(JSON.stringify((await db.query('SELECT * FROM runtime_policy_audit')).rows)).includes('sk-proj-'));
  });

  await reset();
  await t.test('context changed during review cannot acquire the reviewed grant',async()=>{
   await auth.installProfile(p,testProfile());const a=await assign();
   const reviewer:ContentReviewer=async(r,s)=>{
    await db.query('UPDATE runtime_activities SET objective=$2,version=version+1 WHERE id=$1',[a.id,'Changed objective']);
    return allowTestReviewer(r,s);
   };
   assert.equal((await claim(gate(reviewer))).reason,'runtime_context_changed');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_turns')).rows[0].n,0);
  });

  await reset();
  await t.test('claim replay is stable, dispatch is one-shot and policy replacement revokes it',async()=>{
   await auth.installProfile(p,testProfile());await assign();const g=gate(allowTestReviewer);const id=randomUUID();
   const w=(await claim(g,id)).work!;assert.ok(w.authorization);
   assert.deepEqual((await claim(g,id)).work,w);
   await assert.rejects(g.start(p,{...lease(w),grant_id:w.authorization!.id,input_hash:'0'.repeat(64),...testIdentity}),{code:'runtime_approval_invalid'});
   const attempts=await Promise.allSettled([start(g,w),start(g,w)]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
   await auth.installProfile(p,testProfile({version:'test.v2'}));
   assert.equal((await g.lease(p,lease(w))).valid,false);
   await assert.rejects(g.decide(p,decide(w)),{code:'runtime_policy_stale'});
   await assert.rejects(auth.installProfile(p,testProfile({version:'test.v2',max_dispatches_24h:1})),{code:'policy_version_conflict'});
  });

  await reset();
  await t.test('restart preserves reservations, unknown usage never refunds, rolling window reopens',async()=>{
   const profile=testProfile({max_dispatches_24h:1,token_budget_24h:1000});await auth.installProfile(p,profile);await assign();
   const g=gate(allowTestReviewer);const w=(await claim(g)).work!;await start(g,w);await expire();
   const restarted=new RuntimePolicyGate(new RuntimeStore(db),new RuntimeAuthorizationStore(db),allowTestReviewer);
   assert.equal((await claim(restarted)).reason,'runtime_resource_budget');
   await g.usage(p,{...lease(w),total_tokens:null,source:'codex_notification'});
   assert.equal((await auth.budget(p,profile)).tokens,1000);
   await db.query("UPDATE runtime_model_grants SET created_at=clock_timestamp()-interval '25 hours'");
   assert.ok((await claim(restarted)).work);
  });

  await reset();
  await t.test('observed usage is monotonic, scoped and can block future grants above the reserve',async()=>{
   const profile=testProfile({token_budget_24h:2000});await auth.installProfile(p,profile);await assign();const g=gate(allowTestReviewer);
   const w=(await claim(g)).work!;await start(g,w);
   await assert.rejects(g.usage({...p,audienceId:'private'},{...lease(w),total_tokens:1,source:'codex_notification'}),{code:'runtime_usage_invalid'});
   await assert.rejects(g.usage(p,{...lease(w),total_tokens:1,source:'pi_session'}),{code:'runtime_usage_invalid'});
   for(const total of [1800,100,null])await g.usage(p,{...lease(w),total_tokens:total,source:'codex_notification'});
   assert.equal((await auth.budget(p,profile)).tokens,1800);
   await expire();assert.equal((await claim(g)).reason,'runtime_resource_budget');
  });

  await reset();
  await t.test('denied output creates no checkpoint and cannot loop after recovery',async()=>{
   await auth.installProfile(p,testProfile());const a=await assign();
   const reviewer:ContentReviewer=async(r,s)=>r.phase==='input'?allowTestReviewer(r,s):{verdict:'deny',rule_id:'synthetic_disallowed',policy_version:r.policy_version,payload_hash:r.payload_hash};
   const g=gate(reviewer);const w=(await claim(g)).work!;await start(g,w);
   await assert.rejects(g.decide(p,decide(w)),{code:'runtime_output_blocked'});
   assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_checkpoints')).rows[0].n,0);
   await expire();assert.equal((await claim(g)).work,null);
   const row=(await runtime.list(p))[0];assert.equal(row.id,a.id);assert.equal(row.status,'ready');assert.equal(row.blocked_reason,'synthetic_disallowed');
   assert.equal(row.turns_used,1);
  });

  await reset();
  await t.test('output approval is invalidated by profile changes during review, receipt replay is exact',async()=>{
   await auth.installProfile(p,testProfile());await assign();let outputs=0;let change=false;
   const reviewer:ContentReviewer=async(r,s)=>{
    if(r.phase==='output'){outputs++;if(change)await auth.installProfile(p,testProfile({version:'changed'}));}
    return allowTestReviewer(r,s);
   };
   const g=gate(reviewer);const w=(await claim(g)).work!;await start(g,w);const body=decide(w);
   const saved=await g.decide(p,body);assert.deepEqual(await g.decide(p,body),saved);assert.equal(outputs,1);
   await assert.rejects(g.decide(p,{...body,checkpoint:'Altered output'}),{code:'runtime_approval_invalid'});
   await db.query("UPDATE runtime_wakeups SET available_at=clock_timestamp()-interval '1 second' WHERE state='pending'");
   const next=(await claim(g)).work!;await start(g,next);change=true;
   await assert.rejects(g.decide(p,decide(next)),{code:'runtime_policy_stale'});
   assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_checkpoints')).rows[0].n,1);
  });

  await reset();
  await t.test('dispatch lifetime is capped on the server, not just by an engine timer',async()=>{
   await auth.installProfile(p,testProfile({max_model_ms:1000}));await assign();const g=gate(allowTestReviewer);
   const w=(await claim(g)).work!;await start(g,w);
   const timing=(await db.query('SELECT extract(epoch FROM expires_at-started_at)*1000 AS milliseconds FROM runtime_model_grants')).rows[0];
   assert.ok(Number(timing.milliseconds)<=1001);
   await db.query("UPDATE runtime_model_grants SET expires_at=clock_timestamp()-interval '1 second'");
   assert.equal((await g.lease(p,lease(w))).valid,false);
   await assert.rejects(g.decide(p,decide(w)),{code:'runtime_approval_expired'});
   assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_checkpoints')).rows[0].n,0);
  });

  await reset();
  await t.test('parallel authorization cannot over-reserve the character budget',async()=>{
   await auth.installProfile(p,testProfile({max_dispatches_24h:1,token_budget_24h:1000}));await assign();const g=gate(allowTestReviewer);
   const results=await Promise.all([claim(g),claim(g)]);assert.equal(results.filter(r=>r.work).length,1);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_model_grants')).rows[0].n,1);
  });

  await reset();
  await t.test('configured bridge integrates with input/output gates and durable reviewer budget',async()=>{
   await auth.installProfile(p,testProfile());await assign();const rules='Synthetic fixture rules only. '.repeat(5);
   const reviewer=createProcessReviewer({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-reviewer-child.mjs',import.meta.url))],cwd:'/private/tmp',
    policy_versions:['test.v1'],rules,rules_hash:fingerprint(rules),privacy_reviewed:true,expires_at:new Date(Date.now()+60000).toISOString(),timeout_ms:2000,max_requests_24h:2},
    signal=>auth.reserveReview(p,2,signal));
   const g=new RuntimePolicyGate(runtime,auth,reviewer,3000);const w=(await claim(g)).work!;assert.ok(w);await start(g,w);await g.decide(p,decide(w));
   assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_review_dispatches')).rows[0].n,2);
   await db.query("UPDATE runtime_wakeups SET available_at=clock_timestamp()-interval '1 second' WHERE state='pending'");
   assert.equal((await claim(g)).reason,'reviewer_budget');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_model_grants')).rows[0].n,1);
  });

  await reset();
  await t.test('review dispatch budget survives restart, serializes reservations and spans audiences',async()=>{
   const signal=new AbortController().signal;
   await auth.installProfile(p,testProfile());
   const results=await Promise.all([auth.reserveReview(p,1,signal),auth.reserveReview({...p,audienceId:'other'},1,signal)]);
   assert.equal(results.filter(Boolean).length,1);
   assert.equal(await new RuntimeAuthorizationStore(db).reserveReview(p,1,signal),false);
   await db.query("UPDATE runtime_review_dispatches SET created_at=clock_timestamp()-interval '25 hours'");
   assert.equal(await auth.reserveReview(p,1,signal),true);
   assert.equal(await auth.reserveReview(p,10,signal,{policy_version:'test.v1',rules_hash:'a'.repeat(64)}),true);
   await assert.rejects(auth.reserveReview(p,10,signal,{policy_version:'test.v1',rules_hash:'b'.repeat(64)}),{code:'reviewer_rules_conflict'});
   await assert.rejects(auth.reserveReview(p,10,signal,{policy_version:'unknown',rules_hash:'a'.repeat(64)}),{code:'reviewer_policy_stale'});
  });

  await reset();
  await t.test('operator retry rechecks content, is scoped and replayable, cannot approve denial',async()=>{
   await auth.installProfile(p,testProfile());await assign();const unavailable=gate();await claim(unavailable);
   let h=(await auth.reviewQueue(p))[0];assert.equal(h.verdict,'needs_review');
   assert.equal((await auth.reviewQueue({...p,audienceId:'other'})).length,0);
   const body=()=>({request_id:randomUUID(),activity_id:h.activity_id,activity_version:h.activity_version,policy_version:h.policy_version,payload_hash:h.payload_hash});
   await assert.rejects(auth.retryReview({...p,audienceId:'other'},body()),{code:'review_retry_stale'});
   await assert.rejects(auth.retryReview(p,{...body(),payload_hash:'0'.repeat(64)}),{code:'review_retry_stale'});
   const first=body();assert.deepEqual(await auth.retryReview(p,first),{queued:true});
   assert.deepEqual(await auth.retryReview(p,first),{queued:true});
   await assert.rejects(auth.retryReview(p,{...first,payload_hash:'0'.repeat(64)}),{code:'review_retry_conflict'});
   assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_model_grants')).rows[0].n,0);
   // Re-evaluation can block again; retry is never an allow result.
   await claim(unavailable);h=(await auth.reviewQueue(p))[0];
   await assert.rejects(auth.retryReview(p,body()),{code:'review_retry_limit'});
   for(let i=0;i<2;i++){
    await db.query("UPDATE runtime_review_retries SET created_at=clock_timestamp()-interval '2 minutes'");
    await auth.retryReview(p,body());await claim(unavailable);h=(await auth.reviewQueue(p))[0];
   }
   await db.query("UPDATE runtime_review_retries SET created_at=clock_timestamp()-interval '2 minutes'");
   await assert.rejects(auth.retryReview(p,body()),{code:'review_retry_limit'});
   await db.query("UPDATE runtime_policy_holds SET verdict='deny'");
   await assert.rejects(auth.retryReview(p,body()),{code:'review_denial_final'});
   // Owner can edit the objective through existing activity controls; old snapshot is stale.
   await db.query('UPDATE runtime_activities SET version=version+1 WHERE id=$1',[h.activity_id]);
   assert.equal((await auth.reviewQueue(p)).length,0);
   await assert.rejects(auth.retryReview(p,body()),{code:'review_retry_stale'});
  });
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
