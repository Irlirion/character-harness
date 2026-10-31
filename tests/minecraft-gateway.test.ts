import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../apps/core/app.ts';
import type {CoreDeps} from '../apps/core/app.ts';
import type {UnionClefWorkspace} from '../packages/minecraft/unionclef.ts';
import type {TelegramStore} from '../packages/storage/telegram.ts';

const tokens={engine:'e'.repeat(40),owner:'o'.repeat(40),audio:'a'.repeat(40),bridge:'b'.repeat(40)};
const eventId='11111111-1111-4111-8111-111111111111';
function harness(channel:'minecraft'|'telegram',owner=false){
 let revoked=false;const dispatched:unknown[]=[];
 const unused=async()=>{throw new Error('unused dependency');};
 const telegram={scope:async()=>{if(revoked)throw new Error('revoked');return {characterId:'lada',audienceId:channel,channel};},canSendGroup:async()=>owner,canReadGroup:async()=>false} as unknown as TelegramStore;
 const minecraft={catalog:async()=>[{name:'ExecuteCommand',inputSchema:{type:'object'}}],call:async(name:string,args:unknown,invocation:string,epoch:number,guard:()=>Promise<unknown>)=>{await guard();dispatched.push({name,args,invocation,epoch});return {state:'returned',result:{content:[{type:'text',text:'{"ok":true}'}]}};},stop:async()=>({stop_requested:true})} as unknown as UnionClefWorkspace;
 const deps={pool:{query:async()=>({rows:[],rowCount:0}),end:async()=>{}},status:async()=>({paused:false,epoch:7}),search:async()=>[],remember:unused,control:unused,ingest:unused,nextEvent:unused,recentConversation:unused,complete:unused,deferEvent:unused,enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused,enqueueClientAction:unused,clientActionStatus:unused,clientActionLease:unused,claimClientAction:unused,finishClientAction:unused,saveWorldObservation:unused,latestWorldObservation:async()=>({available:false,stale:true,connected:false}),cancelClientActions:unused} as CoreDeps;
 const app=buildApp({principal:{characterId:'lada',audienceId:'demo-public'},tokens,allowSystemChatPublicDemo:true,allowClientWorld:true,minecraftBackend:'unionclef',minecraft,telegram,deps});
 const rpc=(method:string,params:unknown)=>app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${tokens.engine}`,'x-harness-event':eventId,'x-harness-epoch':'7',accept:'application/json, text/event-stream'},payload:{jsonrpc:'2.0',id:1,method,params}});
 return {app,rpc,dispatched,revoke:()=>revoked=true};
}

test('Minecraft and verified owner DM share the complete workspace gateway',async()=>{
 for(const channel of ['minecraft','telegram'] as const){
  const h=harness(channel,true);
  try{
   const catalog=(await h.rpc('tools/list',{})).json().result.tools.map((t:any)=>t.name);
   assert.ok(catalog.includes('minecraft_call'));assert.ok(catalog.includes('minecraft_tools'));assert.ok(catalog.includes('minecraft_stop'));assert.ok(catalog.includes('agent_observe'));assert.ok(!catalog.includes('agent_goto'));
   const response=(await h.rpc('tools/call',{name:'minecraft_call',arguments:{name:'ExecuteCommand',arguments:{cmd:'@get log 3'},invocation_id:'trusted-call',expected_epoch:7}})).json();
   assert.equal(response.result.isError,undefined);assert.equal(h.dispatched.length,1);
  }finally{await h.app.close();}
 }
});

test('ordinary Telegram turns cannot call the shared Minecraft client',async()=>{
 const h=harness('telegram',false);
 try{
  const names=(await h.rpc('tools/list',{})).json().result.tools.map((t:any)=>t.name);assert.ok(!names.includes('minecraft_call'));assert.ok(!names.includes('agent_observe'));
  const denied=(await h.rpc('tools/call',{name:'minecraft_call',arguments:{name:'ExecuteCommand',arguments:{cmd:'@stop'},invocation_id:'spoof',expected_epoch:7}})).json();
  assert.ok(denied.error||denied.result.isError);assert.equal(h.dispatched.length,0);
 }finally{await h.app.close();}
});

test('workspace heartbeat is bridge-authenticated and unavailable for a stale scene',async()=>{
 const h=harness('minecraft');
 try{
  const denied=await h.app.inject({url:'/bridge/minecraft/lease',headers:{authorization:`Bearer ${tokens.engine}`}});assert.equal(denied.statusCode,401);
  const response=await h.app.inject({url:'/bridge/minecraft/lease',headers:{authorization:`Bearer ${tokens.bridge}`}});assert.equal(response.statusCode,200);assert.equal(response.json().enabled,true);assert.equal(response.json().valid,false);
 }finally{await h.app.close();}
});
