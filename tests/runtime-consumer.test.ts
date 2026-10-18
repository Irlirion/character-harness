import { approveTestWork, testIdentity } from './fixtures/runtime-policy.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RuntimeConsumer, type RuntimeApi } from '../packages/runtime/consumer.ts';
import { planningInput, runtimeEngineEnabled, type RuntimeWork, type PlanningDecision } from '../packages/runtime/protocol.ts';

export function work():RuntimeWork {
  return approveTestWork({activity:{id:randomUUID(),objective:'Prepare a plan',origin:'owner',version:2,max_turns:10,turns_used:1,input_reply:null},
    turn:{id:randomUUID(),epoch:4,lease_token:randomUUID(),lease_until:new Date(Date.now()+90000).toISOString()},
    checkpoint:'Earlier plan',audience_id:'demo',persona:'Character identity',wake_reason:'created'});
}
const result:PlanningDecision={checkpoint:'Next step',decision:{action:'complete',summary:'Plan prepared'}};

test('runtime engine flag and model projection do not leak lease credentials',()=>{
  assert.equal(runtimeEngineEnabled(undefined),false);assert.equal(runtimeEngineEnabled('false'),false);assert.equal(runtimeEngineEnabled('true'),true);
  assert.throws(()=>runtimeEngineEnabled('yes'));
  const w=work();const text=JSON.stringify(planningInput(w));
  assert.ok(!text.includes(w.turn.lease_token));assert.ok(!text.includes(w.turn.id));assert.ok(!text.includes('expected_version'));
});

test('idle and blocked runtime never call a model',async()=>{
  for(const reason of ['idle_or_budget_blocked','runtime_policy_blocked','paused']){
    let calls=0;
    const consumer=new RuntimeConsumer(async()=>({work:null,reason}),testIdentity);
    assert.deepEqual(await consumer.tick(async()=>{calls++;return result;},new AbortController().signal),{worked:false,reason});
    assert.equal(calls,0);
  }
});

test('lost claim response reuses request_id and lost receipt retries only the decision',async()=>{
  const w=work();const requests:any[]=[];const decisions:unknown[]=[];let polls=0,models=0;
  const api:RuntimeApi=async(path,body)=>{
    if(path==='/engine/next_work'){requests.push(body);if(++polls===1)throw new Error('response_lost');return {work:w};}
    if(path==='/engine/work_start')return {allowed:true};
    if(path==='/engine/work_usage')return {saved:true};
    if(path==='/engine/work_lease')return {valid:true};
    decisions.push(body);if(decisions.length===1)throw new Error('commit_response_lost');return {saved:true};
  };
  const consumer=new RuntimeConsumer(api,testIdentity);const signal=new AbortController().signal;
  await assert.rejects(consumer.tick(async()=>{models++;return result;},signal),/response_lost/);
  assert.equal(models,0);
  assert.deepEqual(await consumer.tick(async()=>{models++;return result;},signal),{worked:true});
  assert.deepEqual(requests[0],requests[1]);assert.equal(models,1);
  assert.equal(decisions.length,2);assert.deepEqual(decisions[0],decisions[1]);
  assert.equal((decisions[0] as any).epoch,w.turn.epoch);
});

test('lease denial and transport failure prevent inference',async()=>{
  for(const failure of [false,true]){
    let models=0,commits=0;
    const consumer=new RuntimeConsumer(async(path)=>{
      if(path==='/engine/next_work')return {work:work()};
      if(path==='/engine/work_decision'){commits++;return {};}
      if(failure)throw new Error('lease_check_failed');return {valid:false};
    },testIdentity);
    await assert.rejects(consumer.tick(async()=>{models++;return result;},new AbortController().signal));
    assert.equal(models,0);assert.equal(commits,0);
  }
});

test('revoked lease aborts even an uncooperative provider and does not commit',async()=>{
  let checks=0,commits=0;let received:AbortSignal|undefined;
  const consumer=new RuntimeConsumer(async path=>{
    if(path==='/engine/next_work')return {work:work()};
    if(path==='/engine/work_start')return {allowed:true};
    if(path==='/engine/work_usage')return {saved:true};
    if(path==='/engine/work_lease')return {valid:++checks===1};
    commits++;return {};
  },testIdentity);
  await assert.rejects(consumer.tick(async(_input,_persona,signal)=>{received=signal;return new Promise(()=>{});},new AbortController().signal,{fenceMs:5,maxModelMs:1000}),/runtime_turn_revoked/);
  assert.equal(received?.aborted,true);assert.equal(commits,0);
});

test('model deadline, shutdown, invalid output and precommit revocation never save a decision',async()=>{
  for(const scenario of ['deadline','shutdown','invalid','precommit']){
    const stop=new AbortController();let checks=0,commits=0;
    const consumer=new RuntimeConsumer(async path=>{
      if(path==='/engine/next_work')return {work:work()};
      if(path==='/engine/work_start')return {allowed:true};
    if(path==='/engine/work_usage')return {saved:true};
    if(path==='/engine/work_lease')return {valid:scenario!=='precommit'||++checks===1};
      commits++;return {};
    },testIdentity);
    await assert.rejects(consumer.tick(async()=>{
      if(scenario==='shutdown'){stop.abort();return result;}
      if(scenario==='deadline')return new Promise(()=>{});
      if(scenario==='invalid')return {checkpoint:'x',decision:{action:'publish'}} as unknown as PlanningDecision;
      return result;
    },stop.signal,{fenceMs:100,maxModelMs:10}));
    assert.equal(commits,0,scenario);
  }
});

test('tampered approved input and a lost start permit never trigger inference',async()=>{
 for(const tamper of [true,false]){
  const w=work();if(tamper)w.model_input!.checkpoint='Changed after review';
  let starts=0,models=0;
  const consumer=new RuntimeConsumer(async(path)=>{
   if(path==='/engine/next_work')return {work:w};
   if(path==='/engine/work_lease')return {valid:true};
   if(path==='/engine/work_start'){starts++;throw new Error('start_response_lost');}
   return {saved:true};
  },testIdentity);
  await assert.rejects(consumer.tick(async()=>{models++;return result;},new AbortController().signal));
  assert.equal(models,0);assert.equal(starts,tamper?0:1);
 }
});

test('consumer reports observed usage outside model arguments, keeps the maximum and reports unknown on abort',async()=>{
 for(const fail of [true,false]){
  const reports:any[]=[];
  const consumer=new RuntimeConsumer(async(path,body)=>{
   if(path==='/engine/next_work')return {work:work()};
   if(path==='/engine/work_lease')return {valid:true};
   if(path==='/engine/work_start')return {allowed:true};
   if(path==='/engine/work_usage')reports.push(body);
   return {saved:true};
  },testIdentity);
  const pending=consumer.tick(async(_input,_persona,_signal,onUsage)=>{
   if(fail)throw new Error('provider_disconnected');
   for(const value of [100,30,-1,180])onUsage?.(value);return result;
  },new AbortController().signal);
  if(fail)await assert.rejects(pending);else await pending;
  assert.equal(reports.length,1);assert.equal(reports[0].total_tokens,fail?null:180);assert.equal(reports[0].source,'codex_notification');
 }
});
