import {DirectedReviewError,directedErrorDetail} from '../packages/storage/telegram-directed.ts';
import {buildApp} from '../apps/core/app.ts';
import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';import {readFile,readdir} from 'node:fs/promises';
import {TelegramStore} from '../packages/storage/telegram.ts';import {RuntimeAuthorizationStore} from '../packages/storage/runtime-authorization.ts';import {testProfile,allowTestReviewer} from './fixtures/runtime-policy.ts';
test('ambiguous addressee is reported distinctly from unavailable delivery',()=>{assert.deepEqual(directedErrorDetail(new DirectedReviewError('directed_recipient_unclear','owner_request_ambiguous_recipient')),{error:'directed_recipient_unclear',rule_id:'owner_request_ambiguous_recipient',reason:'Не удалось однозначно понять, кого поздравить или кому адресовать текст. Уточни человека; подключённая группа уже выбрана.'});});
const p={characterId:'lada',audienceId:'demo-public'};
test('natural-language private owner group sends are reviewed, scoped and durable',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='directed_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});let db:pg.Pool|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);db=new pg.Pool({connectionString:url.toString()});const pool=db;
  for(const f of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const auth=new RuntimeAuthorizationStore(pool);let reviews:any[]=[],deny=false,revoke=false,readerRevoke=false;const reads:any[]=[];const owner=randomUUID();
  const tg=new TelegramStore(pool,'lada',undefined,{timeoutMs:1000,reviewer:async(r,s)=>{reviews.push(r.payload);if(revoke)await pool.query('UPDATE telegram_bindings SET runtime_control=false,revision=revision+1 WHERE kind=\'private\'');return {...await allowTestReviewer(r,s),...(deny?{verdict:'deny' as const,rule_id:'test_blocked'}:{})};}},async(chatId,ids)=>{reads.push({chatId,ids});if(readerRevoke)await pool.query("UPDATE telegram_bindings SET enabled=false,revision=revision+1 WHERE kind='group'");return {member_count:3,administrators:[{display_name:'Admin',username:null,status:'administrator'}],known_members:[{display_name:'Misha',username:null,status:'member'}],count_error:null,administrators_error:null,member_lookup_errors:0};});
  let priv:any,group:any,uid=0;
  const reset=async()=>{await pool.query('TRUNCATE characters CASCADE');await pool.query("INSERT INTO characters(id,name,persona) VALUES('lada','Lada','test')");await tg.register('99','bot');await tg.polling('99',owner);await tg.accountState('99','connected',owner);priv=await tg.bind('99','8','private',true);group=await tg.bind('99','-42','group',true);await tg.runtimeControl(priv.id,true);await auth.installProfile(p,testProfile());reviews=[];deny=false;revoke=false;readerRevoke=false;reads.length=0;};
  const event=async(text='напиши в группу',chat=8,kind='private',author=8)=>{
   await tg.ingest('99',owner,[{update_id:++uid,message:{message_id:uid,date:Math.floor(Date.now()/1000),chat:{id:chat,type:kind},from:{id:author,is_bot:false},text}}]);
   if(kind!=='private')await pool.query("UPDATE telegram_messages SET observed_at=now()-interval '11 seconds'");await tg.prepare();
   const e=(await pool.query('SELECT * FROM social_events WHERE NOT processed ORDER BY created_at LIMIT 1')).rows[0];assert.ok(e);
   const c=(await pool.query("UPDATE characters SET epoch=epoch+1,active_event_id=$1,lease_until=clock_timestamp()+interval '90 seconds' WHERE id='lada' RETURNING epoch",[e.id])).rows[0];return {...e,epoch:c.epoch};
  };
  const scope=()=>({...p,audienceId:priv.audience_id});
  await t.test('plain request publishes once without reply target and status confirms Telegram receipt',async()=>{
   await reset();const e=await event();assert.equal(await tg.canSendGroup(scope(),e.id,e.epoch),true);
   const [a,b]=await Promise.all([tg.sendGroup(scope(),e.id,e.epoch,'Привет! Как ваши постройки?'),tg.sendGroup(scope(),e.id,e.epoch,'Привет! Как ваши постройки?')]);assert.equal(a.id,b.id);
   assert.equal((await pool.query('SELECT count(*)::int n FROM telegram_outbox')).rows[0].n,1);assert.equal(reviews[0].current_owner_request.includes('напиши в группу'),true);
   await assert.rejects(tg.sendGroup(scope(),e.id,e.epoch,'Another message'),{code:'directed_message_already_requested'});
   const job=await tg.claim('99',owner);assert.ok(job);assert.equal(job.chat_id,'-42');assert.equal(job.reply_to,null);
   await tg.delivered(job.id,job.claim_id,'sent','701');assert.equal((await tg.groupDelivery(scope(),e.id,e.epoch,a.id))!.state,'sent');
   await tg.finish(e.id,e.epoch,'reply','Написала в группу.');
  });
  await t.test('follow-up review receives confirmed same-group relay and resolves the previous addressee',async()=>{
   await reset();const first=await event('Напиши в группу Ильсуру');await tg.sendGroup(scope(),first.id,first.epoch,'Ильсур, привет!');const job=await tg.claim('99',owner);await tg.delivered(job!.id,job!.claim_id,'sent','710');await tg.finish(first.id,first.epoch,'reply','Написала Ильсуру в группу.');const ack=await tg.claim('99',owner);await tg.delivered(ack!.id,ack!.claim_id,'sent','712');
   const second=await event('Поздравь его с наступающим хелуином');await tg.sendGroup(scope(),second.id,second.epoch,'Ильсур, с наступающим Хеллоуином!');
   const checked=reviews.at(-1);assert.ok(checked.current_owner_request.includes('Поздравь его'));
   assert.equal(checked.recent_confirmed_group_deliveries.length,1);assert.ok(checked.recent_confirmed_group_deliveries[0].owner_request.includes('Ильсуру'));assert.equal(checked.recent_confirmed_group_deliveries[0].sent_text,'Ильсур, привет!');
   assert.equal(checked.target,'single_configured_group');const next=await tg.claim('99',owner);assert.equal(next!.chat_id,'-42');
  });
  await t.test('unconfirmed, old and reconfigured-group sends cannot become confirmed follow-up context',async()=>{
   for(const kind of ['unknown','old','reconfigured']){
    await reset();const first=await event('Напиши в группу Ильсуру');await tg.sendGroup(scope(),first.id,first.epoch,'Ильсур, привет!');const job=await tg.claim('99',owner);await tg.delivered(job!.id,job!.claim_id,kind==='unknown'?'unknown':'sent',kind==='unknown'?undefined:'711');await tg.finish(first.id,first.epoch,'reply','Обработала поручение.');
    if(kind==='old')await pool.query("UPDATE telegram_outbox SET send_started_at=now()-interval '31 minutes' WHERE id=$1",[job!.id]);
    if(kind==='reconfigured'){await tg.bind('99','-42','group',false);await tg.bind('99','-42','group',true);}
    const second=await event('Поздравь его');await tg.sendGroup(scope(),second.id,second.epoch,'С праздником!');assert.equal(reviews.at(-1).recent_confirmed_group_deliveries.length,0);
   }
  });
  await t.test('participants are read on demand for authorized scopes without storing a roster',async()=>{
   await reset();await pool.query("INSERT INTO telegram_messages(binding_id,message_id,author_id,text,consumed) VALUES($1,'known','telegram:22','Public group message',true)",[group.id]);
   const e=await event('Кто есть в группе?');const d=await tg.groupParticipants(scope(),e.id,e.epoch);assert.equal(d.complete,false);assert.equal(d.target,'configured_group');assert.equal(d.member_count,3);assert.equal(d.known_members[0].display_name,'Misha');assert.deepEqual(reads,[{chatId:'-42',ids:['22']}]);assert.equal((await pool.query('SELECT count(*)::int n FROM telegram_messages')).rows[0].n,2);
   readerRevoke=true;await assert.rejects(tg.groupParticipants(scope(),e.id,e.epoch));
   await reset();const g=await event('Кто здесь?',-42,'supergroup');const current=await tg.groupParticipants({...p,audienceId:group.audience_id},g.id,g.epoch);assert.equal(current.target,'current_group');
   await reset();const stranger=await event('Список участников',8,'private',9);await assert.rejects(tg.groupParticipants(scope(),stranger.id,stranger.epoch),{code:'directory_owner_required'});assert.equal(reads.length,0);
  });
  await t.test('private owner MCP exposes send/status and executes the ordinary dialogue tool path',async()=>{
   await reset();const e=await event();const tokens={engine:'e'.repeat(64),owner:'o'.repeat(64),audio:'a'.repeat(64),bridge:'b'.repeat(64),telegram:'t'.repeat(64)};
   const unused=async()=>{throw new Error('unused');};
   const app=buildApp({principal:p,tokens,allowSystemChatPublicDemo:false,telegram:tg,deps:{pool,status:unused,search:unused,remember:unused,control:unused,ingest:unused,nextEvent:unused,recentConversation:unused,complete:unused,deferEvent:unused,enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused,enqueueClientAction:unused,clientActionStatus:unused,clientActionLease:unused,claimClientAction:unused,finishClientAction:unused,saveWorldObservation:unused,latestWorldObservation:unused,cancelClientActions:unused}});
   try{
    const base=await app.listen({port:0,host:'127.0.0.1'});
    const headers={'Content-Type':'application/json',authorization:'Bearer '+tokens.engine,'x-harness-event':e.id,'x-harness-epoch':String(e.epoch),accept:'application/json, text/event-stream'};
    const rpc=async(method:string,params:any)=>{const response=await fetch(base+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return {json:()=>response.json()};};
    const catalog=(await (await rpc('tools/list',{})).json()).result.tools.map((x:any)=>x.name);assert.ok(catalog.includes('telegram_group_participants'));assert.ok(catalog.includes('telegram_send_group'));assert.ok(catalog.includes('telegram_group_delivery'));assert.ok(!catalog.includes('agent_walk'));
    const queued=await (await rpc('tools/call',{name:'telegram_send_group',arguments:{text:'Привет, группа!'}})).json();assert.equal(queued.result.isError,undefined);const receipt=JSON.parse(queued.result.content[0].text);assert.equal(receipt.state,'pending');
    const job=await tg.claim('99',owner);await tg.delivered(job!.id,job!.claim_id,'sent','702');
    const status=await (await rpc('tools/call',{name:'telegram_group_delivery',arguments:{id:receipt.id}})).json();assert.equal(JSON.parse(status.result.content[0].text).state,'sent');
   }finally{await app.close();}
  });
  await t.test('group and wrong private sender cannot obtain sending authority',async()=>{
   for(const [chat,kind,author] of [[-42,'supergroup',8],[8,'private',9]] as const){await reset();const e=await event('напиши в группу',chat,kind,author);const s={...p,audienceId:e.audience_id};assert.equal(await tg.canSendGroup(s,e.id,e.epoch),false);await assert.rejects(tg.sendGroup(s,e.id,e.epoch,'Forbidden'),{code:'directed_owner_required'});assert.equal(reviews.length,0);}
  });
  await t.test('blocked review, stale lease and authority revocation enqueue nothing',async()=>{
   await reset();let e=await event();deny=true;await assert.rejects(tg.sendGroup(scope(),e.id,e.epoch,'Bad text'),{code:'directed_content_blocked'});assert.equal((await pool.query('SELECT count(*)::int n FROM telegram_outbox')).rows[0].n,0);
   deny=false;revoke=true;await assert.rejects(tg.sendGroup(scope(),e.id,e.epoch,'Safe text'),{code:'directed_owner_required'});assert.equal((await pool.query('SELECT count(*)::int n FROM telegram_outbox')).rows[0].n,0);
   await reset();e=await event();await pool.query("UPDATE characters SET lease_until=now()-interval '1 second'");await assert.rejects(tg.sendGroup(scope(),e.id,e.epoch,'Expired'),{code:'directed_owner_required'});
  });
  await t.test('policy replacement, binding revocation and tampered text cancel queued posts',async()=>{
   for(const change of ['policy','source','target','text']){await reset();const e=await event();await tg.sendGroup(scope(),e.id,e.epoch,'Safe text');
    if(change==='policy')await auth.installProfile(p,testProfile({version:'v2'}));
    if(change==='source')await tg.runtimeControl(priv.id,false);
    if(change==='target')await tg.bind('99','-42','group',false);
    if(change==='text')await pool.query("UPDATE telegram_outbox SET text='Tampered'");
    assert.equal(await tg.claim('99',owner),null);assert.equal((await pool.query('SELECT state FROM telegram_outbox')).rows[0].state,'cancelled');
   }
  });
  await t.test('ambiguous send is reported as unknown and not requeued',async()=>{
   await reset();const e=await event();const a=await tg.sendGroup(scope(),e.id,e.epoch,'Safe text'),job=await tg.claim('99',owner);await tg.delivered(job!.id,job!.claim_id,'unknown');assert.equal((await tg.sendGroup(scope(),e.id,e.epoch,'Safe text')).state,'unknown');assert.equal((await tg.groupDelivery(scope(),e.id,e.epoch,a.id))!.state,'unknown');assert.equal(await tg.claim('99',owner),null);
  });
 }finally{await db?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
