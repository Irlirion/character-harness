import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../apps/core/app.ts';
import type {CoreDeps} from '../apps/core/app.ts';
import type {UnionClefWorkspace} from '../packages/minecraft/unionclef.ts';
import type {TelegramStore} from '../packages/storage/telegram.ts';

const tokens={engine:'e'.repeat(40),owner:'o'.repeat(40),audio:'a'.repeat(40),bridge:'b'.repeat(40)};
const eventId='11111111-1111-4111-8111-111111111111';
function harness(channel:'minecraft'|'telegram',owner=false,turns=false){
 let revoked=false;const dispatched:unknown[]=[];
 const unused=async()=>{throw new Error('unused dependency');};
 const telegram={scope:async()=>{if(revoked)throw new Error('revoked');return {characterId:'lada',audienceId:channel,channel};},canSendGroup:async()=>owner,canReadGroup:async()=>false} as unknown as TelegramStore;
 const minecraft={observe:async()=>({connected:true,stale:false,snapshot:{self:{pos:'0,64,0'}}}),catalog:async()=>[{name:'ExecuteCommand',inputSchema:{type:'object'}}],call:async(name:string,args:unknown,invocation:string,epoch:number,guard:()=>Promise<unknown>)=>{await guard();dispatched.push({name,args,invocation,epoch});return {state:'returned',result:{content:[{type:'text',text:'{"ok":true}'}]}};},stop:async()=>({stop_requested:true})} as unknown as UnionClefWorkspace;
 const deps={pool:{query:async()=>({rows:[],rowCount:0}),end:async()=>{}},status:async()=>({paused:false,epoch:7}),search:async()=>[],remember:unused,control:unused,ingest:unused,nextEvent:unused,recentConversation:unused,complete:unused,deferEvent:unused,enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused,} as CoreDeps;
 deps.latestWorldObservation=async()=>({available:true,connected:true,stale:false,snapshot:{self:{yaw:5,minecraft_workspace_ready:false}}});
 if(turns){deps.enqueueClientAction=async(_p,id,kind,args,duration,epoch)=>{dispatched.push({id,kind,args,duration,epoch});return {id:eventId,state:'pending'};};deps.clientActionStatus=async()=>({state:'completed',evidence:{start_yaw:0,end_yaw:45}});}
 const app=buildApp({principal:{characterId:'lada',audienceId:'demo-public'},tokens,minecraft,telegram,deps,allowClientWorld:turns});
 const rpc=(method:string,params:unknown)=>app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${tokens.engine}`,'x-harness-event':eventId,'x-harness-epoch':'7',accept:'application/json, text/event-stream'},payload:{jsonrpc:'2.0',id:1,method,params}});
 return {app,rpc,dispatched,revoke:()=>revoked=true};
}

test('Minecraft turns queue a bounded rotation and report observed result',async()=>{
 const h=harness('minecraft',false,true);
 try {
  const names=(await h.rpc('tools/list',{})).json().result.tools.map((t:any)=>t.name);
  assert.ok(names.includes('agent_turn'));assert.ok(names.includes('agent_action_status'));
  const queued=(await h.rpc('tools/call',{name:'agent_turn',arguments:{yaw_degrees:45,pitch_degrees:0,invocation_id:'turn-1',expected_epoch:7}})).json();
  assert.equal(queued.result.isError,undefined);assert.equal(h.dispatched.length,1);
  const state=(await h.rpc('tools/call',{name:'agent_action_status',arguments:{id:eventId}})).json();
  assert.match(JSON.stringify(state),/completed/);
  const invalid=(await h.rpc('tools/call',{name:'agent_turn',arguments:{yaw_degrees:180,pitch_degrees:0,invocation_id:'turn-2',expected_epoch:7}})).json();
  assert.ok(invalid.error||invalid.result.isError);assert.equal(h.dispatched.length,1);
 } finally {await h.app.close();}
});

test('direct workspace observation excludes unrelated companion watchdog flag',async()=>{
 const h=harness('minecraft',false,true);
 try {
  const result=(await h.rpc('tools/call',{name:'agent_observe',arguments:{}})).json();
  const observation=JSON.parse(result.result.content[0].text);
  assert.equal(observation.connected,true);
  assert.equal(observation.client_observation.snapshot.self.yaw,5);
  assert.equal('minecraft_workspace_ready' in observation.client_observation.snapshot.self,false);
 } finally {await h.app.close();}
});

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
