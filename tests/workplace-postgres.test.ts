import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {RuntimeStore} from '../packages/storage/runtime.ts';
import {RuntimeAuthorizationStore} from '../packages/storage/runtime-authorization.ts';
import {RuntimePolicyGate} from '../packages/runtime/gate.ts';
import {TelegramStore} from '../packages/storage/telegram.ts';
import {scheduleAutonomy,daytime,initiativeDeliveryValid,commitDesk} from '../packages/storage/workplace.ts';
import {PlanningDecisionSchema} from '../packages/runtime/protocol.ts';
import {attemptDelivery} from '../packages/telegram/delivery.ts';
import {testProfile,allowTestReviewer,testIdentity} from './fixtures/runtime-policy.ts';

test('desk output cannot name host paths or unknown authority',()=>{
 assert.equal(PlanningDecisionSchema.safeParse({checkpoint:'',decision:{action:'complete',summary:'Done'},desk:{expected_revision:1,notes:'',plan:'',path:'/etc/passwd'}}).success,false);
 assert.equal(daytime(new Date('2026-10-18T08:00:00Z')),true);
 assert.equal(daytime(new Date('2026-10-18T20:00:00Z')),false);
});
test('first messages omit reply target',async()=>{
 let payload:any;await attemptDelivery({call:async(_method:any,p:any)=>{payload=p;return {message_id:1};}} as any,{chat_id:'-1',reply_to:null,text:'A useful thought'});
 assert.equal('reply_parameters' in payload,false);
});
test('persistent autonomous workplace and checked initiative',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='workplace_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});let pool:pg.Pool|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);pool=new pg.Pool({connectionString:url.toString()});const db=pool;
  for(const f of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.query(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));
  await db.query("INSERT INTO characters(id,name,persona) VALUES('lada','Lada','Fictional helpful character')");
  const runtime=new RuntimeStore(db),auth=new RuntimeAuthorizationStore(db),tg=new TelegramStore(db,'lada',runtime),owner=randomUUID();
  await tg.register('99','bot');await tg.polling('99',owner);await tg.accountState('99','connected',owner);const group=await tg.bind('99','-42','group',true),p={characterId:'lada',audienceId:group.audience_id};
  await tg.autonomy(group.id,true);await auth.installProfile(p,testProfile());
  const schedule=async(at=new Date('2026-10-18T10:00:00Z'))=>{const c=await db.connect();try{await c.query('BEGIN');await c.query("SELECT * FROM characters WHERE id='lada' FOR UPDATE");await scheduleAutonomy(c,p,at);await c.query('COMMIT');}finally{c.release();}};
  await db.query("UPDATE runtime_autonomy SET next_wake_at=now()-interval '1 minute'");
  await schedule(new Date('2026-10-18T23:00:00Z'));assert.equal((await runtime.list(p)).length,0);
  await Promise.all([schedule(),schedule()]);assert.equal((await runtime.list(p)).length,1);assert.equal((await runtime.list(p))[0].origin,'self');
  const gate=new RuntimePolicyGate(runtime,auth,allowTestReviewer),w=(await gate.claim(p,{request_id:randomUUID(),...testIdentity})).work!;assert.ok(w);
  assert.deepEqual(w.model_input!.desk,{revision:1,notes:'',plan:''});assert.equal(w.model_input!.autonomy!.posting_allowed,true);
  const lease={turn_id:w.turn.id,epoch:w.turn.epoch,lease_token:w.turn.lease_token};await gate.start(p,{...lease,grant_id:w.authorization!.id,input_hash:w.authorization!.input_hash,...testIdentity});
  const body={...lease,invocation_id:randomUUID(),expected_version:w.activity.version,checkpoint:'Useful local work',decision:{action:'complete',summary:'Prepared a conversation idea'},desk:{expected_revision:1,notes:'Ideas for this group',plan:'Avoid repeating recent topics'},shared_desk:{expected_revision:1,notes:'I enjoy collaborative creative projects',plan:'Develop a bridge-building idea for both channels'},initiative:{text:'Можем устроить небольшую совместную стройку на выходных.',reason:'A concrete optional group activity'}};
  // Exercise the actual outbox insert with a fixed daytime clock, then roll it back.
  const c=await db.connect();try{
   await c.query('BEGIN');const state=(await c.query("SELECT * FROM characters WHERE id='lada' FOR UPDATE")).rows[0];
   await commitDesk(c,p,body as any,w.activity,true,{...state,db_now:new Date('2026-10-18T10:00:00Z')});
   const job=(await c.query('SELECT * FROM telegram_outbox')).rows[0];assert.equal(job.reply_to,null);assert.equal(job.runtime_turn_id,w.turn.id);assert.equal(job.text,body.initiative.text);
   assert.equal(await initiativeDeliveryValid(c,job,new Date('2026-10-18T10:00:00Z')),true);
   await c.query("INSERT INTO telegram_messages(binding_id,message_id,author_id,text) VALUES($1,'1','telegram:8','Hello')",[group.id]);
   assert.equal(await initiativeDeliveryValid(c,job,new Date('2026-10-18T10:00:00Z')),false);
   await c.query('DELETE FROM telegram_messages');
   await c.query('UPDATE runtime_autonomy SET revision=revision+1');assert.equal(await initiativeDeliveryValid(c,job,new Date('2026-10-18T10:00:00Z')),false);
   await c.query('ROLLBACK');
  }finally{c.release();}
  const noPost={...body,initiative:undefined};await gate.decide(p,noPost);await gate.decide(p,noPost);
  const restarted=new RuntimeStore(db);assert.equal((await restarted.desk(p)).desk.revision,2);assert.equal((await restarted.desk(p)).desk.notes,'Ideas for this group');
  assert.equal((await restarted.desk({...p,audienceId:'private'})).desk.notes,'');
  assert.equal((await restarted.desk({...p,audienceId:'demo-public'})).shared_desk.notes,'I enjoy collaborative creative projects');
  assert.equal((await restarted.desk({...p,characterId:'another'})).shared_desk.notes,'');
  await assert.rejects(runtime.assign(p,{invocation_id:'forged',objective:'x',origin:'self'}));
  await db.query("UPDATE runtime_autonomy SET next_wake_at=now()-interval '1 minute'");await schedule();
  let reviewed:any;const rejectGate=new RuntimePolicyGate(runtime,auth,async(r,s)=>{if(r.phase==='output'){reviewed=r.payload;return {...await allowTestReviewer(r,s),verdict:'deny',rule_id:'test_denied'};}return allowTestReviewer(r,s);});
  const second=(await rejectGate.claim(p,{request_id:randomUUID(),...testIdentity})).work!;assert.ok(second);const l2={turn_id:second.turn.id,epoch:second.turn.epoch,lease_token:second.turn.lease_token};await rejectGate.start(p,{...l2,grant_id:second.authorization!.id,input_hash:second.authorization!.input_hash,...testIdentity});
  await assert.rejects(rejectGate.decide(p,{...body,...l2,expected_version:second.activity.version,desk:{...body.desk,expected_revision:2}}),{code:'runtime_output_blocked'});
  assert.equal(reviewed.shared_desk.notes,body.shared_desk.notes);assert.equal((await restarted.desk(p)).shared_desk.revision,2);
  assert.equal(reviewed.initiative.text,body.initiative.text);assert.equal(reviewed.desk.notes,body.desk.notes);
  assert.equal((await db.query('SELECT count(*)::int n FROM telegram_outbox')).rows[0].n,0);assert.equal((await restarted.desk(p)).desk.revision,2);
  await tg.autonomy(group.id,false);assert.equal((await restarted.desk(p)).autonomy,undefined);
  assert.equal((await gate.claim(p,{request_id:randomUUID(),...testIdentity})).work,null);
  const privateScope={...p,audienceId:'private'};await runtime.assign(privateScope,{invocation_id:'race',objective:'Maintain my common plan'});
  const changingGate=new RuntimePolicyGate(runtime,auth,async(r,s)=>{if(r.phase==='input')await db.query("UPDATE runtime_shared_desks SET revision=revision+1,plan='Concurrent update'");return allowTestReviewer(r,s);});
  assert.equal((await changingGate.claim(privateScope,{request_id:randomUUID(),...testIdentity})).reason,'runtime_context_changed');
  const fresh=(await gate.claim(privateScope,{request_id:randomUUID(),...testIdentity})).work!;assert.ok(fresh);assert.equal(fresh.model_input!.shared_desk!.plan,'Concurrent update');assert.equal(fresh.model_input!.desk!.notes,'');
  const fl={turn_id:fresh.turn.id,epoch:fresh.turn.epoch,lease_token:fresh.turn.lease_token};await gate.start(privateScope,{...fl,grant_id:fresh.authorization!.id,input_hash:fresh.authorization!.input_hash,...testIdentity});
  await db.query('UPDATE runtime_shared_desks SET revision=revision+1');
  await assert.rejects(gate.decide(privateScope,{...fl,invocation_id:'stale-shared',expected_version:fresh.activity.version,checkpoint:'Do not commit stale notes',decision:{action:'complete',summary:'Local work'},shared_desk:{expected_revision:fresh.model_input!.shared_desk!.revision,notes:'Stale overwrite',plan:''}}),{code:'shared_desk_revision_conflict'});
  assert.equal((await restarted.desk(p)).shared_desk.plan,'Concurrent update');
  assert.equal((await db.query('SELECT state FROM runtime_model_grants WHERE turn_id=$1',[fresh.turn.id])).rows[0].state,'started');
  const client=await db.connect();try{assert.equal(await initiativeDeliveryValid(client,{binding_id:group.id,autonomy_revision:1,autonomy_epoch:1,id:randomUUID()}),false);}finally{client.release();}
 }finally{await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
