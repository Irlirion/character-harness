import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp,type CoreDeps} from '../apps/core/app.ts';
import type {UnionClefWorkspace} from '../packages/minecraft/unionclef.ts';

const tokens={engine:'e'.repeat(64),owner:'o'.repeat(64),audio:'a'.repeat(64),bridge:'b'.repeat(64)};
const event={id:'event-current',text:'current event',channel:'minecraft'};
const history=[{event_id:'event-before',input:'earlier',reply:'response'}];
const unused=async()=>{throw new Error('unused dependency called');};
function deps(next:unknown,requested:any[]):CoreDeps{return {
 pool:{query:async()=>({rows:[],rowCount:0}),end:async()=>{}},status:async()=>({paused:false,epoch:7}),search:async()=>[],remember:unused,
 control:unused,ingest:unused,nextEvent:async()=>next,recentConversation:async(_p,eventId)=>{requested.push(eventId);return history;},complete:unused,deferEvent:unused,
 enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused
};}

test('/engine/input includes conversation and a direct UnionClef observation for an active Minecraft event',async()=>{
 const requested:string[]=[];const world={available:true,connected:true,stale:false,snapshot:{inGame:true,self:{pos:'1,64,2'}}};
 const minecraft={observe:async()=>world} as unknown as UnionClefWorkspace;
 const app=buildApp({principal:{characterId:'lada',audienceId:'demo-public'},tokens,minecraft,deps:deps(event,requested)});
 try{
  const r=await app.inject({url:'/engine/input',headers:{authorization:`Bearer ${tokens.engine}`}});
  assert.equal(r.statusCode,200);assert.deepEqual(r.json().recent_conversation,history);assert.deepEqual(r.json().world_observation,world);assert.deepEqual(requested,['event-current']);
 }finally{await app.close();}
});

test('/engine/input reports no Minecraft state when UnionClef is not configured',async()=>{
 const app=buildApp({principal:{characterId:'lada',audienceId:'demo-public'},tokens,deps:deps(event,[])});
 try{
  const r=await app.inject({url:'/engine/input',headers:{authorization:`Bearer ${tokens.engine}`}});
  assert.deepEqual(r.json().world_observation,{available:false,connected:false,stale:true,state:'not_configured'});
 }finally{await app.close();}
});
