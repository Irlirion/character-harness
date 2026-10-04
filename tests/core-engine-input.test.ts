import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/core/app.ts';

const tokens={engine:'e'.repeat(64),owner:'o'.repeat(64),audio:'a'.repeat(64),bridge:'b'.repeat(64)};
const event={id:'event-current',text:'current event'};
const history=[{event_id:'event-before',input:'earlier',reply:'response',author_provenance:'fabric_profile_context',author_trust:'unverified'}];
const unused=async()=>{throw new Error('unused dependency called');};

test('/engine/input loads prior conversation for the current scoped event and omits it when there is no event',async()=>{
  const requested:{characterId:string;audienceId:string;eventId:string}[]=[];
  let next:unknown=event;
  const app=buildApp({
    principal:{characterId:'sever',audienceId:'demo-public'},tokens,allowSystemChatPublicDemo:false,
    deps:{
      pool:{query:async()=>({rows:[],rowCount:0}),end:async()=>{}},
      status:async()=>({paused:false,epoch:7}),search:async()=>[],remember:unused,control:unused,ingest:unused,
      nextEvent:async()=>next,recentConversation:async(p,eventId)=>{requested.push({...p,eventId});return history;},
      complete:unused,deferEvent:unused,enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused,
      enqueueClientAction:unused,clientActionStatus:unused,clientActionLease:unused,claimClientAction:unused,finishClientAction:unused,
      saveWorldObservation:unused,latestWorldObservation:unused,cancelClientActions:unused
    }
  });
  try{
    const first=await app.inject({url:'/engine/input',headers:{authorization:`Bearer ${tokens.engine}`}});
    assert.equal(first.statusCode,200);
    assert.deepEqual(first.json().recent_conversation,history);
    assert.deepEqual(requested,[{characterId:'sever',audienceId:'demo-public',eventId:'event-current'}]);
    next=null;
    const idle=await app.inject({url:'/engine/input',headers:{authorization:`Bearer ${tokens.engine}`}});
    assert.deepEqual(idle.json().recent_conversation,[]);
    assert.equal(requested.length,1);
  }finally{await app.close();}
});
