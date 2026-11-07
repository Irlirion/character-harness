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
