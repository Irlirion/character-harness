import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/core/app.ts';

const tokens={engine:'e'.repeat(64),owner:'o'.repeat(64),audio:'a'.repeat(64),bridge:'b'.repeat(64)};
const event={id:'event-current',text:'current event'};
const history=[{event_id:'event-before',input:'earlier',reply:'response',author_provenance:'fabric_profile_context',author_trust:'unverified'}];
const unused=async()=>{throw new Error('unused dependency called');};

test('/engine/input loads prior conversation for the current scoped event and omits it when there is no event',async()=>{
  const requested:{characterId:string;audienceId:string;eventId:string}[]=[];
  const observationScopes:{characterId:string;audienceId:string}[]=[];
  const snapshot={available:true,stale:false,connected:true,session_id:'session-id',server:'mc.agicraft.ru:25565',age_ms:459,
    snapshot:{observed_at:new Date().toISOString(),players:[{name:'Irlirion',uuid:'11111111-1111-4111-8111-111111111111',distance:1.82,line_of_sight:true}],crosshair:{type:'player'}}};
  let next:unknown=event;
  const app=buildApp({
    principal:{characterId:'lada',audienceId:'demo-public'},tokens,allowSystemChatPublicDemo:false,allowClientWorld:true,
    deps:{
      pool:{query:async()=>({rows:[],rowCount:0}),end:async()=>{}},
      status:async()=>({paused:false,epoch:7}),search:async()=>[],remember:unused,control:unused,ingest:unused,
      nextEvent:async()=>next,recentConversation:async(p,eventId)=>{requested.push({...p,eventId});return history;},
      complete:unused,deferEvent:unused,enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused,
      enqueueClientAction:unused,clientActionStatus:unused,clientActionLease:unused,claimClientAction:unused,finishClientAction:unused,
      saveWorldObservation:unused,latestWorldObservation:async(p)=>{observationScopes.push({...p});return snapshot;},cancelClientActions:unused
    }
  });
  try{
    const first=await app.inject({url:'/engine/input',headers:{authorization:`Bearer ${tokens.engine}`}});
    assert.equal(first.statusCode,200);
    assert.deepEqual(first.json().recent_conversation,history);
    assert.deepEqual(first.json().world_observation,snapshot);
    assert.deepEqual(requested,[{characterId:'lada',audienceId:'demo-public',eventId:'event-current'}]);
    assert.deepEqual(observationScopes,[{characterId:'lada',audienceId:'demo-public'}]);
    next=null;
    const idle=await app.inject({url:'/engine/input',headers:{authorization:`Bearer ${tokens.engine}`}});
    assert.deepEqual(idle.json().recent_conversation,[]);
    assert.equal(requested.length,1);
    assert.equal('world_observation' in idle.json(),false);
  }finally{await app.close();}
});

test('/engine/input never sends a stale stored world snapshot to the turn',async()=>{
  const staleSnapshot={available:true,stale:true,connected:false,age_ms:4000,
    snapshot:{players:[{name:'OldPlayer',distance:1}]}};
  const app=buildApp({
    principal:{characterId:'lada',audienceId:'demo-public'},tokens,allowSystemChatPublicDemo:false,allowClientWorld:true,
    deps:{
      pool:{query:async()=>({rows:[],rowCount:0}),end:async()=>{}},
      status:async()=>({paused:false,epoch:8}),search:async()=>[],remember:unused,control:unused,ingest:unused,
      nextEvent:async()=>event,recentConversation:async()=>[],complete:unused,deferEvent:unused,enqueueSpeech:unused,
      claimSpeech:unused,speechState:unused,updateSpeech:unused,enqueueClientAction:unused,clientActionStatus:unused,
      clientActionLease:unused,claimClientAction:unused,finishClientAction:unused,saveWorldObservation:unused,
      latestWorldObservation:async()=>staleSnapshot,cancelClientActions:unused
    }
  });
  try{
    const r=await app.inject({url:'/engine/input',headers:{authorization:`Bearer ${tokens.engine}`}});
    assert.deepEqual(r.json().world_observation,{available:true,stale:true,connected:false,server:null,age_ms:4000});
    assert.equal('snapshot' in r.json().world_observation,false);
  }finally{await app.close();}
});

test('owner inspect reconstructs pending input without claiming or mutating the event',async()=>{
  const calls:string[]=[];
  const event={id:'11111111-1111-4111-8111-111111111111',author_id:'private-external-id',source_key:'owner:demo',text:'hi'};
  const app=buildApp({principal:{characterId:'lada',audienceId:'demo-public'},tokens,allowSystemChatPublicDemo:false,memoryInstructions:'memory rules',deps:{
    pool:{query:async()=>({rows:[],rowCount:0}),end:async()=>{}},
    status:async()=>{calls.push('status');return {paused:false,epoch:5,persona:'secret persona'};},
    search:async()=>{calls.push('search');return [];},remember:unused,control:unused,ingest:unused,
    nextEvent:async()=>{calls.push('claim');return event;},recentConversation:async()=>{calls.push('history');return [];},
    inspectEvent:async(_p,id)=>{calls.push('inspect');assert.equal(id,event.id);return event;},
    loadSocialMemory:async()=>{calls.push('social');return {working_state:{version:3,topic:null,goal:null,open_questions:[],commitment_keys:[],last_event_id:null},current_person:null,facts:[],relationships:[],commitments:[],other_open_commitment_count:0};},
    complete:unused,deferEvent:unused,enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused, enqueueClientAction:async()=>({}),clientActionStatus:async()=>({}),clientActionLease:async()=>({}),claimClientAction:async()=>null,finishClientAction:async()=>({}),saveWorldObservation:async()=>({}),latestWorldObservation:async()=>null,cancelClientActions:async()=>({})
  }});
  try{
    const result=await app.inject({url:'/owner/inspect-context?event_id='+event.id,headers:{authorization:`Bearer ${tokens.owner}`}});
    assert.equal(result.statusCode,200);
    const payload=result.json();
    assert.equal(payload.turn_input.event.speaker_ref,'current_speaker');
    assert.equal(JSON.stringify(payload).includes('private-external-id'),false);
    assert.equal(JSON.stringify(payload).includes('secret persona'),false);
    assert.equal(payload.diagnostics.reconstruction,'current_scoped_memory_for_selected_pending_event');
    assert.equal(calls.includes('claim'),false);
    assert.deepEqual(calls.sort(),['history','inspect','search','social','status']);
  }finally{await app.close();}
});
