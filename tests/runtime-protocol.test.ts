import { DomainError } from '../packages/domain/policy.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RuntimeEngineStore } from '../apps/core/runtime.ts';
import { runtimeApp, runtimeTokens, runtimePrincipal } from './fixtures/runtime-app.ts';
import { RuntimeWorkSchema } from '../packages/runtime/protocol.ts';

const work=()=>({activity:{id:randomUUID(),objective:'Plan',origin:'owner',version:2,max_turns:10,turns_used:1,input_reply:null,create_payload:'private metadata'},
  turn:{id:randomUUID(),epoch:5,lease_token:randomUUID(),lease_until:new Date(Date.now()+90000)},checkpoint:'Prior',wake_reason:'created'});
const lease=()=>({turn_id:randomUUID(),epoch:5,lease_token:randomUUID()});

test('runtime protocol is closed without policy; client cannot bypass by adding an allow flag',async()=>{
  let calls=0;
  const forbidden=async()=>{calls++;throw new Error('must_not_run');};
  const store:RuntimeEngineStore={claim:forbidden,lease:forbidden,decide:forbidden,assertLegacyTurn:forbidden};
  const app=runtimeApp({runtimeEngine:store});const headers={authorization:`Bearer ${runtimeTokens.engine}`};
  try{
    const blocked=await app.inject({method:'POST',url:'/engine/next_work',headers,payload:{request_id:'x'}});
    assert.equal(blocked.statusCode,200);assert.deepEqual(blocked.json(),{work:null,reason:'runtime_policy_blocked'});
    assert.equal(blocked.headers['cache-control'],'no-store');
    const invalid=await app.inject({method:'POST',url:'/engine/next_work',headers,payload:{request_id:'x',allow:true}});
    assert.equal(invalid.statusCode,400);
    const l=lease();assert.deepEqual((await app.inject({method:'POST',url:'/engine/work_lease',headers,payload:l})).json(),{valid:false});
    assert.equal((await app.inject({method:'POST',url:'/engine/work_decision',headers,payload:{...l,expected_version:2,invocation_id:'x',checkpoint:'x',decision:{action:'continue'}}})).statusCode,409);
    assert.equal(calls,0);
  }finally{await app.close();}
});

test('runtime protocol checks engine role, scope, policy at each boundary and projects DB records',async()=>{
  const calls:unknown[][]=[];const w=work();let allowed=true;
  const store:RuntimeEngineStore={
    claim:async(...args)=>{calls.push(['claim',...args]);return {work:w};},
    lease:async(...args)=>{calls.push(['lease',...args]);return {valid:true};},
    decide:async(...args)=>{calls.push(['decide',...args]);return {saved:true};},assertLegacyTurn:async()=>{},
  };
  const phases:string[]=[];
  const app=runtimeApp({runtimeEngine:store,runtimePolicy:{
    claim:async(p,b)=>{phases.push('claim');assert.deepEqual(p,runtimePrincipal);if(!allowed)return {work:null};const r=await store.claim(p,b);return {work:{...r.work!,turn:{...w.turn,lease_until:w.turn.lease_until.toISOString()},audience_id:p.audienceId,persona:'Persona'}};},
    lease:async(p,b)=>{phases.push('lease');return allowed?store.lease(p,b):{valid:false};},
    decide:async(p,b)=>{phases.push('decision');if(!allowed)throw new DomainError('runtime_policy_blocked');return store.decide(p,b);},
    start:async()=>({allowed:false}),usage:async()=>({saved:true}),
  }});
  const headers={authorization:`Bearer ${runtimeTokens.engine}`};
  try{
    for(const token of [undefined,runtimeTokens.owner,runtimeTokens.audio,runtimeTokens.bridge])assert.equal((await app.inject({method:'POST',url:'/engine/next_work',headers:token?{authorization:`Bearer ${token}`}:{},payload:{request_id:'x'}})).statusCode,401);
    assert.equal(calls.length,0);
    for(const extra of [{audience_id:'private'},{character_id:'other'}])assert.equal((await app.inject({method:'POST',url:'/engine/next_work',headers,payload:{request_id:'x',...extra}})).statusCode,400);
    const claim=await app.inject({method:'POST',url:'/engine/next_work',headers,payload:{request_id:'x'}});
    assert.equal(claim.statusCode,200);RuntimeWorkSchema.parse(claim.json().work);
    assert.ok(!claim.body.includes('private metadata'));
    assert.deepEqual(calls[0],['claim',runtimePrincipal,{request_id:'x'}]);
    const l={turn_id:w.turn.id,epoch:w.turn.epoch,lease_token:w.turn.lease_token};
    assert.equal((await app.inject({method:'POST',url:'/engine/work_lease',headers,payload:l})).json().valid,true);
    const body={...l,expected_version:2,invocation_id:'x',checkpoint:'x',decision:{action:'continue'}};
    assert.equal((await app.inject({method:'POST',url:'/engine/work_decision',headers,payload:body})).statusCode,200);
    allowed=false;const count=calls.length;
    assert.equal((await app.inject({method:'POST',url:'/engine/work_lease',headers,payload:l})).json().valid,false);
    assert.equal((await app.inject({method:'POST',url:'/engine/work_decision',headers,payload:body})).statusCode,409);
    assert.equal(calls.length,count);assert.ok(phases.includes('claim')&&phases.includes('lease')&&phases.includes('decision'));
  }finally{await app.close();}
});
