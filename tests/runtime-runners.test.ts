import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { runPiPlanning, type PlanningSessionFactory } from '../packages/runtime/pi-runner.ts';
import { runCodexPlanning, type PlanningRpc } from '../packages/runtime/codex-runner.ts';
import { type PlanningDecision, type PlanningInput } from '../packages/runtime/protocol.ts';

const input:PlanningInput={activity:{id:'activity',objective:'Plan',origin:'owner',remaining_turns:3,input_reply:null},checkpoint:'Previous plan',audience_id:'demo',wake_reason:'at_time',suggested_wakeup_at:new Date(Date.now()+180000).toISOString()};
const decision:PlanningDecision={checkpoint:'New plan',decision:{action:'request_input',question:'Which materials?'}};
const call=(tool:ToolDefinition,value:unknown,signal:AbortSignal)=>tool.execute('call',value,signal,undefined,{} as any);

test('Pi runtime has one lifecycle tool, rejects extra authority and requires an explicit decision',async()=>{
  let disposed=0;
  const signal=new AbortController().signal;
  const factory:PlanningSessionFactory=async(system,tools)=>{
    assert.match(system,/Only activity_decide/);assert.deepEqual(tools.map(t=>t.name),['activity_decide']);
    return {prompt:async text=>{
      assert.deepEqual(JSON.parse(text),input);
      await assert.rejects(call(tools[0],{...decision,epoch:100},signal));
      await call(tools[0],decision,signal);
      await assert.rejects(call(tools[0],decision,signal),/activity_already_decided/);
    },abort:async()=>{},dispose:()=>{disposed++;}};
  };
  assert.deepEqual(await runPiPlanning(factory,input,'Persona',signal),decision);assert.equal(disposed,1);
  await assert.rejects(runPiPlanning(async()=>({prompt:async()=>{},abort:async()=>{},dispose:()=>{disposed++;}}),input,'Persona',signal),/activity_decision_missing/);
  assert.equal(disposed,2);
});

test('Pi runtime aborts and disposes a session without publishing a late decision',async()=>{
  const stop=new AbortController();let aborted=0,disposed=0;
  await assert.rejects(runPiPlanning(async()=>({prompt:async()=>{queueMicrotask(()=>stop.abort());return new Promise(()=>{});},abort:async()=>{aborted++;},dispose:()=>{disposed++;}}),input,'Persona',stop.signal));
  assert.equal(aborted,1);assert.equal(disposed,1);
});

function fakeRpc(action:(rpc:PlanningRpc)=>Promise<void>) {
  const calls:{method:string;params:any}[]=[];
  const rpc:PlanningRpc={onNotification:()=>{},onRequest:async()=>{throw new Error('unset');},request:async(method,params:any)=>{
    calls.push({method,params});
    if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start'){
      rpc.onNotification('turn/started',{threadId:'thread',turn:{id:'turn'}});
      queueMicrotask(()=>{void action(rpc).catch(()=>rpc.onNotification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'failed',error:{message:'fake_assertion_failed'}}}));});
      return {turn:{id:'turn'}};
    }
    return {};
  }};
  return {rpc,calls};
}
const params=(extra={})=>({threadId:'thread',turnId:'turn',tool:'activity_decide',arguments:decision,...extra});

test('Codex runtime grants only activity_decide and fences wrong tool, thread, turn and repeated decisions',async()=>{
  const {rpc,calls}=fakeRpc(async rpc=>{
    for(const extra of [{tool:'shell'},{tool:'memory_propose'},{tool:'image_generate'},{threadId:'foreign'},{turnId:'stale'}]){
      await assert.rejects(rpc.onRequest('item/tool/call',params(extra)),/runtime_tool_denied/);
    }
    await assert.rejects(rpc.onRequest('command/exec',params()),/runtime_tool_denied/);
    const accepted:any=await rpc.onRequest('item/tool/call',params());assert.equal(accepted.success,true);
    await assert.rejects(rpc.onRequest('item/tool/call',params()),/activity_already_decided/);
    rpc.onNotification('turn/completed',{threadId:'foreign',turn:{id:'turn',status:'failed'}});
    rpc.onNotification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}});
  });
  assert.deepEqual(await runCodexPlanning(rpc,'/isolated','configured-model',input,'Persona',new AbortController().signal),decision);
  const start=calls[0].params;assert.equal(start.ephemeral,true);assert.equal(start.sandbox,'read-only');assert.equal(start.approvalPolicy,'never');
  assert.deepEqual(start.runtimeWorkspaceRoots,[]);assert.deepEqual(start.dynamicTools.map((t:any)=>t.name),['activity_decide']);
  assert.ok(!JSON.stringify(calls[1].params.input).includes('lease_token'));
  await assert.rejects(rpc.onRequest('item/tool/call',params()),/no_active_turn/);
});

test('Codex runtime ignores plain text completion and propagates quota failure',async()=>{
  for(const failure of [false,true]){
    const {rpc}=fakeRpc(async rpc=>{
      rpc.onNotification('item/completed',{threadId:'thread',item:{type:'agentMessage',phase:'final_answer',text:'Done'}});
      rpc.onNotification('turn/completed',{threadId:'thread',turn:{id:'turn',status:failure?'failed':'completed',error:{codexErrorInfo:'usageLimitExceeded'}}});
    });
    await assert.rejects(runCodexPlanning(rpc,'/isolated','model',input,'Persona',new AbortController().signal),failure?(error:any)=>error.turn.error.codexErrorInfo==='usageLimitExceeded':/activity_decision_missing/);
  }
});

test('Codex runtime interrupts on shutdown, including a late turn/start response',async()=>{
  const stop=new AbortController();let started:()=>void=()=>{};
  const late=new Promise<any>(resolve=>{started=()=>resolve({turn:{id:'turn'}});});
  const calls:string[]=[];
  const rpc:PlanningRpc={onNotification:()=>{},onRequest:async()=>{},request:async method=>{
    calls.push(method);if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start'){queueMicrotask(()=>stop.abort());return late;}
    return {};
  }};
  await assert.rejects(runCodexPlanning(rpc,'/isolated','model',input,'Persona',stop.signal));
  started();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.ok(calls.includes('turn/interrupt'));
});

test('runtime Codex adapter works over actual stdio RPC with a fake child model',async()=>{
  const {CodexRpc}=await import('../packages/codex/rpc.ts');
  const {fileURLToPath}=await import('node:url');
  const fixture=fileURLToPath(new URL('./fixtures/codex-runtime-child.mjs',import.meta.url));
  for(const mode of ['normal','denied','quota']){
    const rpc=new CodexRpc(process.execPath,process.cwd(),'/tmp/harness-runtime-test',[fixture,mode]);
    try{
      await rpc.initialize();
      const pending=runCodexPlanning(rpc,'/isolated','model',input,'Persona',AbortSignal.timeout(5000));
      if(mode==='normal')assert.deepEqual(await pending,{checkpoint:'Plan from fake Codex',decision:{action:'continue'}});
      else await assert.rejects(pending,/codex_turn_failed/);
    }finally{rpc.close();}
  }
});

test('Minecraft goal uses one compact survey, waits for navigation internally, and commits a structured final answer',async()=>{
 const plan={goal:'Survey the tree',steps:['Choose the site','Reach the site'],completed:1,observation:'Site chosen'};
 const gameInput:PlanningInput={...input,activity:{...input.activity,origin:'self'},minecraft_goal:true,checkpoint:JSON.stringify(plan)};
 const surface=Array.from({length:81},(_,i)=>({dx:String(i%9-4),dz:String(Math.floor(i/9)-4),block:'grass block',top_dy:'-1',hardness:'0.60'}));
 // UnionClef can include a cell with no known surface.
 delete (surface[63] as Partial<typeof surface[number]>).top_dy;
 const gameRequests:string[]=[];
 let polls=0;
 const {rpc,calls}=fakeRpc(async rpc=>{
  const catalog:any=await rpc.onRequest('item/tool/call',params({tool:'activity_minecraft',arguments:{action:'catalog'}}));
  assert.deepEqual(JSON.parse(catalog.contentItems[0].text),[{name:'mineBlock'}]);
  const call:any=await rpc.onRequest('item/tool/call',params({tool:'activity_minecraft',callId:'mine-1',
   arguments:{action:'call',name:'mineBlock',arguments:{x:1,y:64,z:1}}}));
  assert.equal(call.success,true);
  const survey:any=await rpc.onRequest('item/tool/call',params({tool:'activity_minecraft',arguments:{action:'survey'}}));
  const scene=JSON.parse(survey.contentItems[0].text);
  assert.equal(scene.surface.rows.length,9);
  assert.equal(scene.surface.rows[7].split(' ')[0],'?');
  assert.equal(scene.nearby_players,1);
  const greeting:any=await rpc.onRequest('item/tool/call',params({tool:'activity_minecraft',
    arguments:{action:'speak',text:'Привет! Как у тебя дела?'}}));
  assert.equal(greeting.success,true);
  assert.ok(survey.contentItems[0].text.length<JSON.stringify(surface).length/4);
  const tooClose:any=await rpc.onRequest('item/tool/call',params({tool:'activity_minecraft',arguments:{action:'navigate',target:{x:0,y:64,z:0}}}));
  assert.equal(tooClose.success,false);
  assert.match(tooClose.contentItems[0].text,/at least 3 horizontal blocks/);
  const move:any=await rpc.onRequest('item/tool/call',params({tool:'activity_minecraft',arguments:{action:'navigate',target:{x:3,y:64,z:0}}}));
  assert.equal(JSON.parse(move.contentItems[0].text).verified_arrival,true);
  rpc.onNotification('item/completed',{threadId:'thread',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',
   text:JSON.stringify({observation:'Arrived',verified:true,question:null})}});
  rpc.onNotification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}});
 });
 const result=await runCodexPlanning(rpc,'/isolated','model',gameInput,'Persona',AbortSignal.timeout(5000),undefined,async action=>{
  const kind=(action as {action:string}).action;
  gameRequests.push(kind);
  if(kind==='catalog')return [{name:'mineBlock'}];
  if(kind==='call')assert.deepEqual(action,{action:'call',name:'mineBlock',arguments:{x:1,y:64,z:1},call_id:'mine-1'});
  if(kind==='observe')return {connected:true,nearby_players:1,snapshot:{self:{pos:'0,64,0'}}};
  if(kind==='surface')return surface;
  if(kind==='navigate'&&(action as {target:{x:number}}).target.x===0)
   return {target_too_close:true,origin:{x:0,y:64,z:0},minimum_horizontal_distance:3};
  if(kind==='path_status')return {verified_arrival:++polls===2,status:{busy:polls<2,pos:'3,64,0'}};
  return {state:'returned'};
 });
 assert.deepEqual(gameRequests,['catalog','call','observe','surface','speak','navigate','navigate','path_status','path_status']);
 assert.equal(result.decision.action,'complete');
 assert.equal(JSON.parse(result.checkpoint).completed,2);
 assert.deepEqual(calls[0].params.dynamicTools.map((t:any)=>t.name),['activity_minecraft']);
 assert.ok(calls[1].params.outputSchema);
});

test('Minecraft planner can defer a new goal and preserve its reason for the next survey',async()=>{
 const gameInput:PlanningInput={...input,activity:{...input.activity,origin:'self'},minecraft_goal:true,checkpoint:null};
 const {rpc}=fakeRpc(async rpc=>{
  await rpc.onRequest('item/tool/call',params({tool:'activity_minecraft',arguments:{action:'observe'}}));
  rpc.onNotification('item/completed',{threadId:'thread',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',
   text:JSON.stringify({goal:null,steps:[],criteria:[],observation:'The surface is unsafe right now.',retry_after_seconds:90})}});
  rpc.onNotification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}});
 });
 const start=Date.now();
 const result=await runCodexPlanning(rpc,'/isolated','model',gameInput,'Persona',AbortSignal.timeout(5000),undefined,
  async()=>({connected:true,snapshot:{self:{pos:'0,64,0'}}}));
 assert.deepEqual(JSON.parse(result.checkpoint),{deferred_reason:'The surface is unsafe right now.'});
 assert.equal(result.decision.action,'wait_until');
 if(result.decision.action==='wait_until'){
  assert.ok(Date.parse(result.decision.at)>=start+90_000);
  assert.ok(Date.parse(result.decision.at)<=Date.now()+90_000);
 }
 const {validMinecraftGoalDecision}=await import('../packages/runtime/protocol.ts');
 assert.equal(validMinecraftGoalDecision(gameInput,result),true);
});
