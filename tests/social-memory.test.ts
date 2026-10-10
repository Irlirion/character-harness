import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { SocialMemoryDeltaSchema } from '../packages/domain/social-memory.ts';
import { buildApp, type CoreDeps } from '../apps/core/app.ts';
import { makeTurnInput } from '../packages/domain/conversation-context.ts';
import { loadRecentConversation } from '../packages/storage/conversation.ts';

const tokens={engine:'e'.repeat(64),owner:'o'.repeat(64),audio:'a'.repeat(64),bridge:'b'.repeat(64)};
const base={schema_version:1 as const,character_id:'lada',audience_id:'demo',epoch:4,base_state_version:0,people:[],facts:[],relationships:[],commitments:[],working_state:null};

test('social memory contract separates channel identity, subjective relation, and sourced open commitment',()=>{
  const eventId=randomUUID();
  const parsed=SocialMemoryDeltaSchema.parse({...base,
    people:[{channel:'minecraft',external_id:'uuid-player',display_name:'Sasha',provenance:'fabric_profile_context'}],
    relationships:[{person:'uuid-player',note:'Lada enjoyed discussing settlement names',source_event_id:eventId}],
    commitments:[{key:'settlement-name-followup',person:'uuid-player',description:'Discuss two names next time',source_event_id:eventId,status:'open'}],
    working_state:{topic:'Settlement names',goal:'Discuss two options next time',open_questions:[],commitment_keys:['settlement-name-followup'],last_event_id:eventId}
  });
  assert.equal(parsed.people[0].identity_status,'unverified');
  assert.equal(parsed.commitments[0].status,'open');
  assert.throws(()=>SocialMemoryDeltaSchema.parse({...base,people:[{channel:'minecraft',external_id:'name:Sasha',display_name:'Sasha',provenance:'fabric_profile_context',identity_status:'verified'}]}));
  assert.throws(()=>SocialMemoryDeltaSchema.parse({...base,working_state:{topic:null,goal:null,open_questions:[],commitment_keys:[],last_event_id:null},extra:'unexpected'}));
});

test('/engine/complete keeps legacy requests compatible and rejects malformed delta separately',async()=>{
  const calls:any[]=[];
  const unused=async()=>{throw new Error('unused');};
  const deps:CoreDeps={
    pool:{query:async()=>({rows:[],rowCount:0}),end:async()=>{}},status:unused,search:unused,remember:unused,control:unused,ingest:unused,
    nextEvent:unused,recentConversation:unused,complete:async(...args:any[])=>{calls.push(args);return {saved:true,memory:args[6]?{status:'rejected',reason:args[6]}:undefined};},
    deferEvent:unused,enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused
  };
  const app=buildApp({principal:{characterId:'lada',audienceId:'demo'},tokens,deps,allowSystemChatPublicDemo:false});
  const event_id=randomUUID();
  try{
    const headers={authorization:`Bearer ${tokens.engine}`};
    const old=await app.inject({method:'POST',url:'/engine/complete',headers,payload:{event_id,text:'hello',epoch:4}});
    assert.equal(old.statusCode,200);
    assert.equal(calls[0][5],undefined);
    assert.equal(calls[0][6],undefined);
    const malformed=await app.inject({method:'POST',url:'/engine/complete',headers,payload:{event_id,text:'valid answer',epoch:4,memory_delta:{schema_version:9}}});
    assert.equal(malformed.statusCode,200);
    assert.deepEqual(malformed.json().memory,{status:'rejected',reason:'schema_invalid'});
    assert.equal(calls[1][2],'valid answer');
    assert.equal(calls[1][5],undefined);
    assert.equal(calls[1][6],'schema_invalid');
    const silent=await app.inject({method:'POST',url:'/engine/complete',headers,payload:{event_id,epoch:4,decision:'silent'}});
    assert.equal(silent.statusCode,200);
    assert.equal(calls[2][2],null);
    assert.equal(calls[2][8],'silent');
    const invalidSilent=await app.inject({method:'POST',url:'/engine/complete',headers,payload:{event_id,epoch:4,decision:'silent',text:'sentinel'}});
    assert.equal(invalidSilent.statusCode,400);
    assert.equal(calls.length,3);
  }finally{await app.close();}
});

test('PostgreSQL completion commits reply with delta, rejects bad delta locally, and fences replay/version conflicts',
  {skip:!process.env.TEST_DATABASE_URL},async()=>{
    const {completeEvent}=await import('../packages/storage/completion.ts');
  const {stageSocialMemory,loadSocialContext}=await import('../packages/storage/social-memory.ts');
  const schema=`social_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:4});
  const p={characterId:'lada',audienceId:'demo'};
  const eventId=randomUUID();
  const event2=randomUUID();
  const source=(id:string,key:string,author='player-uuid',provenance='owner_input')=>pool.query(`INSERT INTO social_events(id,character_id,audience_id,source_key,author_id,text,author_provenance,author_trust)
    VALUES($1,'lada','demo',$2,$3,'hello',$4,'unverified')`,[id,key,author,provenance]);
  const claim=(id:string)=>pool.query("UPDATE characters SET active_event_id=$1,lease_until=now()+interval '1 minute' WHERE id='lada'",[id]);
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    for(const version of ['001-core','002-speech','003-bridge-delivery','004-bridge-author-provenance','005-event-admission','006-social-memory','007-memory-staging'])
      await pool.query(await readFile(new URL(`../migrations/${version}.sql`,import.meta.url),'utf8'));
    await pool.query("INSERT INTO characters(id,name,persona,epoch) VALUES('lada','Lada','test',4)");
    await source(eventId,'owner:first');
    await source(event2,'owner:second');
    const invalid=SocialMemoryDeltaSchema.parse({...base,people:[{channel:'owner',external_id:'player-uuid',display_name:'Sasha',provenance:'owner_input'}],facts:[{person:'missing',content:'claim',source_event_id:eventId,confidence:0.5,epistemic_status:'inferred',visibility:'audience'}]});
    await claim(eventId);
    const rejected=await completeEvent(pool,p,eventId,'saved response',4,false,invalid,undefined,invalid);
    assert.deepEqual(rejected.memory,{status:'rejected',reason:'unknown_person',state_version:0});
    assert.equal((await pool.query('SELECT processed FROM social_events WHERE id=$1',[eventId])).rows[0].processed,true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM replies WHERE event_id=$1',[eventId])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM social_people')).rows[0].n,0);

    const scopeEvent=randomUUID(); await source(scopeEvent,'owner:scope');
    await claim(scopeEvent);
    const wrongScope=SocialMemoryDeltaSchema.parse({...base,character_id:'other-character'});
    const scopeResult=await completeEvent(pool,p,scopeEvent,'scoped reply',4,false,wrongScope,undefined,wrongScope);
    assert.deepEqual(scopeResult.memory,{status:'rejected',reason:'scope_mismatch'});

    const wrongSourceEvent=randomUUID(); await source(wrongSourceEvent,'owner:source');
    await claim(wrongSourceEvent);
    const wrongSource=SocialMemoryDeltaSchema.parse({...base,facts:[{person:'nobody',content:'claim',source_event_id:randomUUID(),confidence:0.5,epistemic_status:'inferred',visibility:'audience'}]});
    const sourceResult=await completeEvent(pool,p,wrongSourceEvent,'source reply',4,false,wrongSource,undefined,wrongSource);
    assert.deepEqual(sourceResult.memory,{status:'rejected',reason:'source_scope_mismatch'});

    const unfinishedSource=randomUUID(); await source(unfinishedSource,'owner:unfinished');
    const currentSourceCheck=randomUUID(); await source(currentSourceCheck,'owner:current-check');
    await claim(currentSourceCheck);
    const futureSource=SocialMemoryDeltaSchema.parse({...base,relationships:[{person:'player-uuid',note:'claim from unfinished event',source_event_id:unfinishedSource}]});
    const futureSourceResult=await completeEvent(pool,p,currentSourceCheck,'source validation reply',4,false,futureSource,undefined,futureSource);
    assert.deepEqual(futureSourceResult.memory,{status:'rejected',reason:'source_scope_mismatch'});

    await claim(event2);
    const delta=SocialMemoryDeltaSchema.parse({...base,
      people:[{channel:'owner',external_id:'player-uuid',display_name:'Sasha',provenance:'owner_input'}],
      commitments:[{key:'name-chat',person:'player-uuid',description:'Discuss settlement names next time',source_event_id:event2,status:'open'}],
      working_state:{topic:'Settlement names',goal:'Discuss two options',open_questions:[],commitment_keys:['name-chat'],last_event_id:event2}
    });
    const accepted=await completeEvent(pool,p,event2,'new reply',4,false,delta,undefined,delta);
    assert.equal(accepted.memory?.status,'accepted');
    const rows=(await pool.query('SELECT count(*)::int AS people FROM social_people')).rows[0];
    assert.equal(rows.people,1);
    assert.equal((await pool.query('SELECT status FROM social_commitments WHERE commitment_key=$1 ORDER BY version DESC LIMIT 1',['name-chat'])).rows[0].status,'open');
    const replay=await completeEvent(pool,p,event2,'new reply',4,false,delta,undefined,delta);
    assert.equal(replay.replayed,true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM social_commitments')).rows[0].n,1);
    await assert.rejects(completeEvent(pool,p,event2,'different reply',4,false,delta,undefined,delta),{code:'completion_conflict'});

    await pool.query("UPDATE characters SET epoch=5 WHERE id='lada'");
    await assert.rejects(completeEvent(pool,p,event2,'new reply',4,false,delta,undefined,delta),{code:'stale_epoch'});
    await pool.query("UPDATE characters SET epoch=4 WHERE id='lada'");

    const event4=randomUUID(); await source(event4,'owner:fourth'); await claim(event4);
    const noState=SocialMemoryDeltaSchema.parse({...base,base_state_version:1,relationships:[{person:'player-uuid',note:'still discussing names',source_event_id:event4}]});
    const noStateResult=await completeEvent(pool,p,event4,'fourth reply',4,false,noState,undefined,noState);
    assert.equal(noStateResult.memory?.status,'accepted');
    assert.equal((await pool.query('SELECT version FROM social_working_states WHERE character_id=$1',['lada'])).rows[0].version,2);

    const eventClosed=randomUUID(); await source(eventClosed,'owner:closed');
    await claim(eventClosed);
    const unsupportedClose=SocialMemoryDeltaSchema.parse({...base,base_state_version:2,
      commitments:[{key:'unsupported-closed',person:'player-uuid',description:'Claim already done',source_event_id:eventClosed,status:'fulfilled'}]
    });
    const closedResult=await completeEvent(pool,p,eventClosed,'closed reply',4,false,unsupportedClose,undefined,unsupportedClose);
    assert.deepEqual(closedResult.memory,{status:'rejected',reason:'commitment_evidence_required',state_version:2});
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM social_commitments WHERE commitment_key='unsupported-closed'")).rows[0].n,0);

    const eventOrigin=randomUUID(); await source(eventOrigin,'owner:origin');
    await claim(eventOrigin);
    const changedOrigin=SocialMemoryDeltaSchema.parse({...base,base_state_version:2,
      commitments:[{key:'name-chat',person:'player-uuid',description:'Changed origin',source_event_id:eventOrigin,status:'open'}]
    });
    const originResult=await completeEvent(pool,p,eventOrigin,'origin reply',4,false,changedOrigin,undefined,changedOrigin);
    assert.deepEqual(originResult.memory,{status:'rejected',reason:'commitment_origin_immutable',state_version:2});
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM social_commitments WHERE commitment_key='name-chat'")).rows[0].n,1);

    const eventSpeech=randomUUID(); await source(eventSpeech,'owner:speech');
    for(let i=0;i<3;i++) await pool.query(`INSERT INTO speech_jobs(id,character_id,audience_id,request_id,text,epoch,expires_at)
      VALUES($1,'lada','demo',$2,'queued',4,now()+interval '1 minute')`,[randomUUID(),`fixture-${i}`]);
    await claim(eventSpeech);
    await assert.rejects(completeEvent(pool,p,eventSpeech,'spoken',4,true),{code:'speech_queue_full'});
    assert.equal((await pool.query('SELECT processed FROM social_events WHERE id=$1',[eventSpeech])).rows[0].processed,false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM replies WHERE event_id=$1',[eventSpeech])).rows[0].n,0);
    await pool.query('DELETE FROM speech_jobs');
    await claim(eventSpeech);
    await completeEvent(pool,p,eventSpeech,'spoken',4,true);
    const speechReplay=await completeEvent(pool,p,eventSpeech,'spoken',4,true);
    assert.equal(speechReplay.replayed,true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM speech_jobs')).rows[0].n,1);

    const event5=randomUUID(); await source(event5,'telegram:five','telegram-user','legacy_unverified_input');
    await claim(event5);
    const crossChannel=SocialMemoryDeltaSchema.parse({...base,base_state_version:2,
      people:[{channel:'telegram',external_id:'telegram-user',display_name:'Tg user',provenance:'legacy_unverified_input'}],
      relationships:[{person:'player-uuid',note:'cross-channel guess',source_event_id:event5}]
    });
    const crossResult=await completeEvent(pool,p,event5,'fifth reply',4,false,crossChannel,undefined,crossChannel);
    assert.deepEqual(crossResult.memory,{status:'rejected',reason:'unknown_person',state_version:2});
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM social_people')).rows[0].n,1);

    const stale=SocialMemoryDeltaSchema.parse({...delta,base_state_version:0});
    // A new event with a stale state version still commits the reply while preserving the newer projection.
    const event3=randomUUID(); await source(event3,'owner:third');
    await claim(event3);
    const conflict=await completeEvent(pool,p,event3,'third reply',4,false,{...stale,working_state:{...stale.working_state!,last_event_id:event3}},undefined,{...stale,working_state:{...stale.working_state!,last_event_id:event3}});
    assert.deepEqual(conflict.memory,{status:'rejected',reason:'state_version_conflict',state_version:2});
    assert.equal((await pool.query('SELECT goal FROM social_working_states WHERE character_id=$1',['lada'])).rows[0].goal,'Discuss two options');
    const stagedEvent=randomUUID();await source(stagedEvent,'owner:staged');await claim(stagedEvent);
    const proposal={person:{display_name:'Sasha'},facts:[{content:'likes settlement names',confidence:0.7,epistemic_status:'observed' as const}],relationships:[],commitments:[
      {key:'staged-followup',description:'Return to the name options',status:'open' as const},
      {key:'name-chat',description:'Discussed the settlement names',status:'fulfilled' as const}
    ],working_state:null};
    const firstStage=await stageSocialMemory(pool,p,stagedEvent,4,'call-1',proposal);
    assert.equal(firstStage.staged,true);
    const beforeComplete=await loadSocialContext(pool,p,{author_id:'player-uuid',source_key:'owner:staged'});
    assert.equal(beforeComplete.current_person?.display_name,'Sasha');
    assert.ok(!beforeComplete.commitments.some(row=>row.key==='staged-followup'));
    assert.equal(beforeComplete.facts.length,0);
    assert.equal((await stageSocialMemory(pool,p,stagedEvent,4,'call-1',proposal)).replayed,true);
    await assert.rejects(stageSocialMemory(pool,p,stagedEvent,4,'call-1',{...proposal,person:{display_name:'Different'}}),{code:'staging_invocation_conflict'});
    const stagedComplete=await completeEvent(pool,p,stagedEvent,'staged reply',4,false);
    assert.equal(stagedComplete.memory?.status,'accepted');
    const assembled=await loadSocialContext(pool,p,{author_id:'player-uuid',source_key:'owner:staged'});
    const realTurnInput=makeTurnInput({id:stagedEvent,author_id:'player-uuid',source_key:'owner:staged',text:'follow up'},[],[],assembled);
    assert.equal((realTurnInput.event as any).speaker_ref,'current_speaker');
    assert.equal(JSON.stringify(realTurnInput).includes('player-uuid'),false);
    assert.ok(assembled.commitments.some((row:any)=>row.key==='staged-followup'&&row.person_ref==='current_speaker'));
    assert.ok(!assembled.commitments.some((row:any)=>row.key==='name-chat'));
    const closedOrigin=(await pool.query("SELECT source_event_id,evidence_event_id,status FROM social_commitments WHERE commitment_key='name-chat' ORDER BY version DESC LIMIT 1")).rows[0];
    assert.equal(closedOrigin.source_event_id,event2);assert.equal(closedOrigin.evidence_event_id,stagedEvent);assert.equal(closedOrigin.status,'fulfilled');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM social_memory_staging')).rows[0].n,0);
    await pool.query("UPDATE characters SET epoch=5 WHERE id='lada'");
    await assert.rejects(stageSocialMemory(pool,p,stagedEvent,4,'stale-call',proposal),{code:'stale_epoch'});
    const silentEvent=randomUUID();await source(silentEvent,'owner:silent');await claim(silentEvent);
    const silentFact=SocialMemoryDeltaSchema.parse({...base,epoch:5,base_state_version:3,
      facts:[{person:'player-uuid',content:'sent a message that Lada chose not to answer',source_event_id:silentEvent,confidence:0.9,epistemic_status:'observed',visibility:'audience'}]
    });
    const silentResult=await completeEvent(pool,p,silentEvent,null,5,false,silentFact,undefined,silentFact,'silent');
    assert.equal(silentResult.silent,true);assert.equal(silentResult.memory?.status,'accepted');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM replies WHERE event_id=$1',[silentEvent])).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM speech_jobs WHERE request_id=$1",[`reply:${silentEvent}`])).rows[0].n,0);
    assert.equal((await completeEvent(pool,p,silentEvent,null,5,false,silentFact,undefined,silentFact,'silent')).replayed,true);
    await assert.rejects(completeEvent(pool,p,silentEvent,'different',5,false,undefined,undefined,null,'reply'),{code:'completion_conflict'});

    const followEvent=randomUUID();await source(followEvent,'owner:follow-silent');await claim(followEvent);
    const silentSourceFact=SocialMemoryDeltaSchema.parse({...base,epoch:5,base_state_version:4,
      facts:[{person:'player-uuid',content:'later conversation references the silent turn',source_event_id:silentEvent,confidence:0.8,epistemic_status:'observed',visibility:'audience'}]
    });
    const followResult=await completeEvent(pool,p,followEvent,'follow up',5,false,silentSourceFact,undefined,silentSourceFact);
    assert.equal(followResult.memory?.status,'accepted');
    const silentHistory=await loadRecentConversation(pool.query.bind(pool),p,followEvent);
    assert.ok(silentHistory.some(row=>row.event_id===silentEvent&&row.assistant_silent===true&&row.reply===null));

    const silentPromiseEvent=randomUUID();await source(silentPromiseEvent,'owner:silent-promise');await claim(silentPromiseEvent);
    const silentPromise=SocialMemoryDeltaSchema.parse({...base,epoch:5,base_state_version:5,
      commitments:[{key:'silent-promise',person:'player-uuid',description:'A promise from silence',source_event_id:silentPromiseEvent,status:'open'}]
    });
    const silentPromiseResult=await completeEvent(pool,p,silentPromiseEvent,null,5,false,silentPromise,undefined,silentPromise,'silent');
    assert.deepEqual(silentPromiseResult.memory,{status:'rejected',reason:'commitment_reply_required',state_version:5});
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM social_commitments WHERE commitment_key='silent-promise'")).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM replies')).rows[0].n,13);
  }finally{
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
