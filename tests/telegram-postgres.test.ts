import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import {RuntimeStore} from '../packages/storage/runtime.ts';
import { TelegramStore } from '../packages/storage/telegram.ts';
import {sharedDesk} from '../packages/storage/workplace.ts';
import { buildApp } from '../apps/core/app.ts';

test('Telegram PostgreSQL and HTTP contracts', {skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema=`telegram_${randomUUID().replaceAll('-','')}`;
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);
 process.env.DATABASE_URL=url.toString();
 const storage=await import('../packages/storage/db.ts');const pool=storage.pool;
 try {
  for(const f of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(`../migrations/${f}`,import.meta.url),'utf8'));
  const store=new TelegramStore(pool,'lada');const p={characterId:'lada',audienceId:'demo-public'};
  let owner=randomUUID(),uid=0;
  const reset=async()=>{
   await pool.query('TRUNCATE characters CASCADE');
   await pool.query("INSERT INTO characters(id,name,persona) VALUES('lada','Лада','test')");
   owner=randomUUID();uid=0;await store.register('99','LadaBot');await store.polling('99',owner);await store.accountState('99','connected',owner);
  };
  const message=(chat=8,kind='private',direct=false)=>({update_id:++uid,message:{message_id:uid,date:Math.floor(Date.now()/1000),chat:{id:chat,type:kind},from:{id:8,is_bot:false},text:`message ${uid}`,entities:direct?[{type:'mention',offset:0,length:8}]:[]}});
  const input=async()=>{await store.prepare();return storage.nextEvent(p,true);};
  const finish=async(e:any,decision:'reply'|'silence'='reply')=>{
   const epoch=(await storage.status(p)).epoch;
   return store.finish(e.id,epoch,decision,decision==='reply'?'Ответ':undefined);
  };
  await t.test('owner approves discovered groups; joins alone grant no access; revoke and duplicate commands are safe',async()=>{
   await reset();const runtimeStore=new TelegramStore(pool,'lada',new RuntimeStore(pool));
   const priv=await runtimeStore.bind('99','8','private',true);await runtimeStore.runtimeControl(priv.id,true);
   const join=async(chat:number,status='member')=>runtimeStore.ingest('99',owner,[{update_id:++uid,my_chat_member:{chat:{id:chat,type:'supergroup',title:'Test '+chat},new_chat_member:{status}}}]);
   await join(-100);await join(-200);
   assert.equal((await pool.query("SELECT count(*)::int n FROM telegram_bindings WHERE kind='group' AND enabled")).rows[0].n,0);
   await runtimeStore.ingest('99',owner,[message(-100,'supergroup')]);
   assert.equal((await pool.query('SELECT count(*)::int n FROM telegram_messages')).rows[0].n,0,'pending group contents are not stored');
   const refs=(await pool.query("SELECT approval_ref,chat_id FROM telegram_discovered_chats WHERE kind='group' ORDER BY chat_id")).rows;
   const command=async(text:string,author=8)=>{const u=message();u.message.text=text;u.message.from.id=author;await runtimeStore.ingest('99',owner,[u]);return u;};
   await command('/approve_group '+refs[0].approval_ref,777);
   assert.equal((await pool.query("SELECT count(*)::int n FROM telegram_bindings WHERE kind='group'")).rows[0].n,0);
   const forwarded={...message(),message:{...message().message,text:'/approve_group '+refs[0].approval_ref,forward_origin:{type:'user'}}};forwarded.update_id=++uid;
   await runtimeStore.ingest('99',owner,[forwarded]);
   assert.equal((await pool.query("SELECT count(*)::int n FROM telegram_bindings WHERE kind='group'")).rows[0].n,0,'forwarding is not owner approval');
   for(const g of refs)await command('/approve_group '+g.approval_ref);
   assert.equal((await pool.query("SELECT count(*)::int n FROM telegram_bindings WHERE kind='group' AND enabled")).rows[0].n,2);
   assert.equal((await pool.query('SELECT count(*)::int n FROM runtime_autonomy WHERE enabled')).rows[0].n,0);
   const u=await command('/revoke_group '+refs[0].approval_ref);await runtimeStore.ingest('99',owner,[u]);
   const disabled=(await pool.query('SELECT * FROM telegram_bindings WHERE chat_id=$1',[refs[0].chat_id])).rows[0];
   assert.equal(disabled.enabled,false);assert.equal(disabled.revision,2);
   await join(Number(refs[0].chat_id),'left');await command('/approve_group '+refs[0].approval_ref);
   assert.equal((await pool.query('SELECT enabled FROM telegram_bindings WHERE id=$1',[disabled.id])).rows[0].enabled,false,'left bots cannot be approved');
  });
  await t.test('dedup, durable offset, isolated private reply and replayed completion',async()=>{
   await reset();const b=await store.bind('99','8','private',true);
   const u=message();await store.ingest('99',owner,[u]);await store.ingest('99',owner,[u]);
   assert.equal((await pool.query('SELECT count(*)::int n FROM social_events')).rows[0].n,1);
   assert.equal((await store.polling('99',owner)).offset,'2');
   await assert.rejects(store.polling('99',randomUUID()),{code:'poller_busy'});
   const e=await input();assert.equal(e.audience_id,b.audience_id);
   assert.equal(await storage.nextEvent(p,true),null,'only one active character turn');
   const epoch=(await storage.status(p)).epoch;
   await store.finish(e.id,epoch,'reply','Привет');await store.finish(e.id,epoch,'reply','Привет');
   await assert.rejects(store.finish(e.id,epoch,'reply','другое'),{code:'completion_conflict'});
   const job=await store.claim('99',owner);assert.ok(job);assert.equal(job.chat_id,'8');assert.equal(await store.claim('99',owner),null);
   await store.delivered(job.id,job.claim_id,'sent','500');
   assert.equal((await store.history({...p,audienceId:b.audience_id})).messages.at(-1).text,'Привет');
   await assert.rejects(store.history(p),{code:'binding_unavailable'});
   assert.equal((await pool.query('SELECT count(*)::int n FROM speech_jobs')).rows[0].n,0);
  });
  await t.test('group debounce, silence, distinct chat memory and decision budget',async()=>{
   await reset();const b=await store.bind('99','-42','group',true);await store.ingest('99',owner,[message(-42,'supergroup')]);
   assert.equal(await input(),null);
   await pool.query("UPDATE telegram_messages SET observed_at=now()-interval '11 seconds'");
   const e=await input();assert.equal(e.author_metadata.kind,'group');await finish(e,'silence');
   assert.equal((await pool.query('SELECT count(*)::int n FROM telegram_outbox')).rows[0].n,0);
   assert.equal(await input(),null);
   await store.ingest('99',owner,[message(-42,'supergroup')]);await pool.query("UPDATE telegram_messages SET observed_at=now()-interval '11 seconds'");
   assert.equal(await input(),null,'one group decision per 30 seconds');
   await pool.query("UPDATE telegram_decisions SET created_at=now()-interval '31 seconds'");
   const second=await input();assert.ok(second);await finish(second);
   const job=await store.claim('99',owner);assert.ok(job);assert.ok(job);await store.delivered(job.id,job.claim_id,'sent','501');
   await store.ingest('99',owner,[message(-42,'supergroup')]);await pool.query("UPDATE telegram_messages SET observed_at=now()-interval '11 seconds'");await pool.query("UPDATE telegram_decisions SET created_at=now()-interval '31 seconds'");
   await finish(await input());assert.equal((await pool.query('SELECT count(*)::int n FROM telegram_outbox')).rows[0].n,1,'initiative cooldown suppresses extra outbox');
   assert.equal((await store.history({...p,audienceId:b.audience_id})).source,'local_journal');
  });
  await t.test('pause revokes pending sends while sent results survive the race',async()=>{
   await reset();await store.bind('99','8','private',true);await store.ingest('99',owner,[message()]);await finish(await input());
   await storage.control(p,true);assert.equal(await store.claim('99',owner),null);
   assert.equal((await pool.query('SELECT state FROM telegram_outbox')).rows[0].state,'cancelled');
   await storage.control(p,false);await store.ingest('99',owner,[message()]);await finish(await input());const job=await store.claim('99',owner);assert.ok(job);
   await storage.control(p,true);await store.delivered(job.id,job.claim_id,'sent','502');
   assert.equal((await pool.query('SELECT state FROM telegram_outbox WHERE id=$1',[job.id])).rows[0].state,'sent');
  });
  await t.test('unknown is never automatically resent; retry_after and expiry persist',async()=>{
   await reset();await store.bind('99','8','private',true);await store.ingest('99',owner,[message()]);await finish(await input());
   let job=await store.claim('99',owner);assert.ok(job);await pool.query("UPDATE telegram_outbox SET lease_until=now()-interval '1 second'");
   assert.equal(await store.claim('99',owner),null);assert.equal((await pool.query('SELECT state FROM telegram_outbox')).rows[0].state,'unknown');
   await store.resolve(job.id,'retry');job=await store.claim('99',owner);assert.ok(job);await store.delivered(job.id,job.claim_id,'retry_wait',undefined,60,'rate_limited');
   assert.equal(await store.claim('99',owner),null);
   await pool.query("UPDATE telegram_outbox SET retry_at=now()-interval '1 second',expires_at=now()-interval '1 second'");
   assert.equal(await store.claim('99',owner),null);assert.equal((await pool.query('SELECT state FROM telegram_outbox')).rows[0].state,'expired');
  });
  await t.test('bindings, invalid updates, forbidden and auth failures fail closed',async()=>{
   await reset();await assert.rejects(store.bind('100','8','private',true),{code:'bot_not_registered'});
   await store.ingest('99',owner,[message(777)]);assert.equal(await input(),null);
   await store.bind('99','8','private',true);await assert.rejects(store.bind('99','9','private',true),{code:'mvp_binding_limit'});
   await assert.rejects(store.ingest('99',randomUUID(),[message()]),{code:'poller_lease_expired'});
   await assert.rejects(store.ingest('99',owner,[{update_id:3},{update_id:2}]),{code:'invalid_update_order'});
   await store.ingest('99',owner,[message()]);const e=await input();const epoch=(await storage.status(p)).epoch;
   await assert.rejects(store.scope(e.id,epoch+1),{code:'turn_not_active'});
   await assert.rejects(finish(e,'silence'),{code:'silence_private'});await finish(e);
   const job=await store.claim('99',owner);assert.ok(job);await store.delivered(job.id,job.claim_id,'failed',undefined,undefined,'forbidden');
   assert.equal((await store.overview()).bindings[0].enabled,false);
   await store.bind('99','8','private',true);await store.ingest('99',owner,[message()]);await finish(await input());
   await store.accountState('99','auth_required',owner);assert.equal(await store.claim('99',owner),null);
  });
  await t.test('reconfigure fences old turns; old history is retained but cannot trigger a reply',async()=>{
   await reset();const b=await store.bind('99','8','private',true);await store.ingest('99',owner,[message()]);const e=await input();const epoch=(await storage.status(p)).epoch;
   await store.bind('99','8','private',false);await store.bind('99','8','private',true);
   await assert.rejects(store.finish(e.id,epoch,'reply','old'),{code:'stale_epoch'});
   const u=message();u.message.date-=400;await store.ingest('99',owner,[u]);assert.equal(await input(),null);
   assert.equal((await store.history({...p,audienceId:b.audience_id})).messages.length,2);
  });
  await t.test('concurrent claim and completion, expired poller, observation gaps and deferred quota turn',async()=>{
   await reset();await store.bind('99','8','private',true);await store.ingest('99',owner,[message()]);
   const [a,b]=await Promise.all([storage.nextEvent(p,true),storage.nextEvent(p,true)]);
   const e=a??b;assert.ok(e);assert.equal([a,b].filter(Boolean).length,1);
   await storage.deferEvent({...p,audienceId:e.audience_id},e.id,(await storage.status(p)).epoch);const again=await input();assert.equal(again.id,e.id);
   const epoch=(await storage.status(p)).epoch;
   await Promise.all([store.finish(e.id,epoch,'reply','Привет'),store.finish(e.id,epoch,'reply','Привет')]);
   const jobs=await Promise.all([store.claim('99',owner),store.claim('99',owner)]);assert.equal(jobs.filter(Boolean).length,1);
   await pool.query("UPDATE telegram_accounts SET poll_until=now()-interval '1 second',last_poll_at=now()-interval '25 hours'");
   await assert.rejects(store.ingest('99',owner,[message()]),{code:'poller_lease_expired'});
   await assert.rejects(store.claim('99',owner),{code:'poller_lease_expired'});
   owner=randomUUID();await store.polling('99',owner);
   assert.equal((await store.overview()).accounts[0].observation_gap,true);
  });
  await t.test('global retry_after and per-binding rate budgets apply before send',async()=>{
   await reset();await store.bind('99','8','private',true);
   for(let i=0;i<6;i++) {await store.ingest('99',owner,[message()]);await finish(await input());}
   for(let i=0;i<5;i++) {const job=await store.claim('99',owner);assert.ok(job);await store.delivered(job.id,job.claim_id,'sent',String(600+i));}
   assert.equal(await store.claim('99',owner),null,'sixth message waits for minute budget');
   await pool.query("UPDATE telegram_outbox SET send_started_at=now()-interval '61 seconds'");
   const job=await store.claim('99',owner);assert.ok(job);await store.delivered(job.id,job.claim_id,'retry_wait',undefined,60,'rate_limited');
   await pool.query("UPDATE telegram_outbox SET retry_at=now()-interval '1 second'");
   assert.equal(await store.claim('99',owner),null,'account-wide retry_after remains active');
  });
  await t.test('hourly group decision cap and two initiative replies per ten minutes',async()=>{
   await reset();await store.bind('99','-42','group',true);
   for(let i=0;i<3;i++) {
    await store.ingest('99',owner,[message(-42,'supergroup')]);
    await pool.query("UPDATE telegram_messages SET observed_at=now()-interval '11 seconds'");
    await pool.query("UPDATE telegram_decisions SET created_at=now()-interval '31 seconds'");
    await pool.query("UPDATE telegram_outbox SET send_started_at=now()-interval '61 seconds'");
    const e=await input();assert.ok(e);await finish(e);
    const job=await store.claim('99',owner);
    if(i<2) {assert.ok(job);await store.delivered(job.id,job.claim_id,'sent',String(700+i));} else assert.equal(job,null);
   }
   assert.equal((await pool.query('SELECT count(*)::int n FROM telegram_outbox')).rows[0].n,2);
   // Seed 17 further completed decisions in the current hour to reach the cap of 20.
   for(let i=0;i<17;i++) {
    const eid=randomUUID();const binding=(await store.overview()).bindings[0];
    await pool.query(`INSERT INTO social_events(id,character_id,audience_id,source_key,author_id,text,processed) VALUES($1::uuid,'lada',$2,$1::text,'test','test',true)`,[eid,binding.audience_id]);
    await pool.query(`INSERT INTO telegram_decisions(event_id,binding_id,first_seq,last_seq,reply_to,direct,created_at) VALUES($1,$2,$3,$3,'1',false,now()-interval '31 seconds')`,[eid,binding.id,1000+i]);
   }
   await store.ingest('99',owner,[message(-42,'supergroup')]);await pool.query("UPDATE telegram_messages SET observed_at=now()-interval '11 seconds'");
   assert.equal(await input(),null);
   assert.equal((await pool.query('SELECT count(*)::int n FROM telegram_decisions')).rows[0].n,20);
  });
  await t.test('Telegram reply and silence commit staged social memory without cross-chat disclosure',async()=>{
   await reset();const binding=await store.bind('99','8','private',true);
   await store.ingest('99',owner,[message()]);const e=await input();const epoch=(await storage.status(p)).epoch;
   const scoped={...p,audienceId:binding.audience_id};
   await storage.stageMemory(scoped,e.id,epoch,'tg-memory',{person:{display_name:'Собеседник'},facts:[{content:'Любит строить мосты',confidence:0.8,epistemic_status:'observed'}],relationships:[],commitments:[],working_state:null});
   await finish(e);
   assert.equal((await pool.query('SELECT channel FROM replies WHERE event_id=$1',[e.id])).rows[0].channel,'telegram');
   assert.equal((await storage.loadSocialContext(scoped,e)).facts[0].content,'Любит строить мосты');
   assert.equal((await storage.loadSocialContext(p,e)).facts.length,0);
   assert.equal((await pool.query('SELECT count(*)::int n FROM social_memory_staging')).rows[0].n,0);
   await store.bind('99','-42','group',true);await store.ingest('99',owner,[message(-42,'supergroup')]);
   await pool.query("UPDATE telegram_messages SET observed_at=now()-interval '11 seconds'");
   const g=await input();const ge=(await storage.status(p)).epoch;
   await storage.stageMemory({...p,audienceId:g.audience_id},g.id,ge,'tg-silent',{facts:[],relationships:[],commitments:[],working_state:{topic:'Знакомство',goal:null,open_questions:[],commitment_keys:[]}});
   await finish(g,'silence');
   assert.equal((await storage.recentConversation({...p,audienceId:g.audience_id},g.id)).length,0);
   assert.equal((await storage.loadSocialContext({...p,audienceId:g.audience_id},g)).working_state?.topic,'Знакомство');
   assert.equal((await pool.query('SELECT count(*)::int n FROM replies WHERE event_id=$1',[g.id])).rows[0].n,0);
  });
  await t.test('upgrade from standalone Telegram preserves chat journal and adds social memory',async()=>{
   const legacySchema=`legacy_${randomUUID().replaceAll('-','')}`;
   await admin.query(`CREATE SCHEMA ${legacySchema}`);
   const legacyUrl=new URL(process.env.TEST_DATABASE_URL!);legacyUrl.searchParams.set('options',`-c search_path=${legacySchema}`);
   const legacy=new pg.Pool({connectionString:legacyUrl.toString()});
   try {
    const migration=async(name:string)=>legacy.query(await readFile(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8'));
    for(const name of ['001-core','002-speech','003-bridge-delivery','004-bridge-author-provenance','005-event-admission','005-client-actions','006-voice-stt-provenance'])await migration(name);
    await legacy.query('ALTER TABLE characters ADD COLUMN active_event_id uuid REFERENCES social_events(id)');
    const telegramSql=await readFile(new URL('../migrations/010-telegram.sql',import.meta.url),'utf8');
    await legacy.query(telegramSql.split('ALTER TABLE replies DROP CONSTRAINT')[0]);
    await legacy.query("INSERT INTO characters(id,name,persona) VALUES('lada','Лада','test')");
    await legacy.query("INSERT INTO telegram_accounts(bot_id,character_id,username) VALUES('99','lada','LadaBot')");
    const bid=randomUUID();
    await legacy.query("INSERT INTO telegram_bindings(id,bot_id,character_id,chat_id,audience_id,kind) VALUES($1,'99','lada','8','legacy-private','private')",[bid]);
    await legacy.query("INSERT INTO telegram_messages(binding_id,message_id,author_id,text,consumed) VALUES($1,'1','telegram:8','Сохранённая история',true)",[bid]);
    for(const name of ['007-social-memory','008-memory-staging','009-reply-channel','010-telegram'])await migration(name);
    await migration('010-telegram');
    const upgraded=new TelegramStore(legacy,'lada');
    assert.equal((await upgraded.history({characterId:'lada',audienceId:'legacy-private'})).messages[0].text,'Сохранённая история');
    assert.equal((await legacy.query('SELECT count(*)::int n FROM social_people')).rows[0].n,0);
   } finally {await legacy.end();await admin.query(`DROP SCHEMA ${legacySchema} CASCADE`);}
  });
  await t.test('HTTP roles, Telegram context, tool catalog and server-side audience isolation',async()=>{
   await reset();const b=await store.bind('99','8','private',true);await store.ingest('99',owner,[message()]);
   await pool.query(`INSERT INTO memories(id,character_id,audience_id,text,source) VALUES($1,'lada','demo-public','PRIVATE_MINECRAFT_SECRET','test'),($2,'lada',$3,'TELEGRAM_NOTE','test')`,[randomUUID(),randomUUID(),b.audience_id]);
   await pool.query("INSERT INTO runtime_shared_desks(character_id,notes,plan) VALUES('lada','COMMON_AGENT_NOTE','COMMON_AGENT_PLAN')");
   const tokens={engine:'e'.repeat(64),owner:'o'.repeat(64),audio:'a'.repeat(64),bridge:'b'.repeat(64),telegram:'t'.repeat(64)};
   const unused=async()=>{throw new Error('unexpected_game_dependency');};
   const app=buildApp({principal:p,tokens,telegram:store,allowSystemChatPublicDemo:false,allowClientWorld:true,deps:{
    ...storage,pool,loadSharedDesk:p=>sharedDesk(pool,p.characterId),nextEvent:p=>storage.nextEvent(p,true),enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused,
    enqueueClientAction:unused,clientActionStatus:unused,clientActionLease:unused,claimClientAction:unused,finishClientAction:unused,
    saveWorldObservation:unused,latestWorldObservation:unused,cancelClientActions:unused
   }});
   try {
    assert.equal((await app.inject({method:'POST',url:'/telegram/claim',headers:{authorization:`Bearer ${tokens.engine}`},payload:{}})).statusCode,401);
    const r=await app.inject({url:'/engine/input',headers:{authorization:`Bearer ${tokens.engine}`}});assert.equal(r.statusCode,200);
    const value=r.json();assert.equal(value.audience_id,b.audience_id);assert.equal('world_observation' in value,false);
    assert.equal(value.turn_input.agent_desk.notes,'COMMON_AGENT_NOTE');
    assert.ok(r.body.includes('TELEGRAM_NOTE'));assert.ok(!r.body.includes('PRIVATE_MINECRAFT_SECRET'));
    const headers={authorization:`Bearer ${tokens.engine}`,'x-harness-event':value.event.id,'x-harness-epoch':String(value.character.epoch),accept:'application/json, text/event-stream'};
    const rpc=async(method:string,params:any,id=1)=>app.inject({method:'POST',url:'/mcp',headers,payload:{jsonrpc:'2.0',id,method,params}});
    const catalog=await rpc('tools/list',{});assert.equal(catalog.statusCode,200);
    const tools=catalog.json().result.tools.map((x:any)=>x.name);
    assert.ok(tools.includes('telegram_read_history'));assert.ok(!tools.includes('agent_walk'));assert.ok(!tools.includes('agent_observe'));
    const history=await rpc('tools/call',{name:'telegram_read_history',arguments:{}});
    assert.ok(history.body.includes('message 1'));
    const spoof=await rpc('tools/call',{name:'agent_walk',arguments:{forward:1}});assert.ok(spoof.json().error || spoof.json().result.isError);
    await storage.control(p,true);
    assert.equal((await rpc('tools/list',{})).statusCode,409);
   }finally{await app.close();}
  });
 } finally {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
