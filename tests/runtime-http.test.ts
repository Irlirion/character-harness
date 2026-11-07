import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp, type CoreDeps } from '../apps/core/app.ts';
import type { RuntimeOwnerStore } from '../apps/core/runtime.ts';
import { CreateActivitySchema, WorkDecisionSchema, runtimeStorageEnabled } from '../packages/runtime/contracts.ts';
import { DomainError } from '../packages/domain/policy.ts';

const tokens={owner:'o'.repeat(64),engine:'e'.repeat(64),bridge:'b'.repeat(64),audio:'a'.repeat(64)};
const principal={characterId:'lada',audienceId:'demo'};
const unused=async()=>{throw new Error('unexpected dependency');};
function harness(runtime?: RuntimeOwnerStore) {
  const deps: CoreDeps={
    pool:{query:unused,end:unused},status:async()=>({paused:false}),search:unused,remember:unused,control:unused,
    ingest:unused,nextEvent:unused,recentConversation:unused,complete:unused,deferEvent:unused,
    enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused,
    enqueueClientAction:unused,clientActionStatus:unused,clientActionLease:unused,claimClientAction:unused,
    finishClientAction:unused,saveWorldObservation:unused,latestWorldObservation:unused,cancelClientActions:unused,
  };
  return buildApp({principal,tokens,deps,runtime,allowSystemChatPublicDemo:false});
}

test('storage flag defaults off, and strict schemas reject forged authority and malformed decisions',()=>{
  assert.equal(runtimeStorageEnabled(undefined),false);
  assert.equal(runtimeStorageEnabled('false'),false);
  assert.equal(runtimeStorageEnabled('true'),true);
  assert.throws(()=>runtimeStorageEnabled('1'));
  assert.equal(CreateActivitySchema.safeParse({objective:'Plan',invocation_id:'x',origin:'self'}).success,false);
  assert.equal(CreateActivitySchema.safeParse({objective:' ',invocation_id:'x'}).success,false);
  assert.equal(CreateActivitySchema.safeParse({objective:'Plan',invocation_id:'x',max_turns:101}).success,false);
  const b={invocation_id:'x',turn_id:randomUUID(),lease_token:randomUUID(),epoch:1,expected_version:1,checkpoint:''};
  assert.equal(WorkDecisionSchema.safeParse({...b,decision:{action:'complete',summary:'Done',at:'2026-10-18T00:00:00Z'}}).success,false);
  assert.equal(WorkDecisionSchema.safeParse({...b,checkpoint:'a'.repeat(16001),decision:{action:'continue'}}).success,false);
});

test('owner activity API enforces token role, bounded inputs and trusted principal',async()=>{
  const calls: unknown[][]=[];
  const row={id:randomUUID(),status:'ready',version:1};
  const runtime: RuntimeOwnerStore={
    assign:async(...args)=>{calls.push(['assign',...args]);return row;},
    list:async(...args)=>{calls.push(['list',...args]);return [row];},
    inspect:async(...args)=>{calls.push(['inspect',...args]);return {activity:row,checkpoint:null};},
    cancel:async(...args)=>{calls.push(['cancel',...args]);return {...row,status:'cancelled'};},
    provideInput:async(...args)=>{calls.push(['input',...args]);return row;},
  };
  const app=harness(runtime);
  const headers={authorization:`Bearer ${tokens.owner}`};
  try {
    for (const token of [undefined,tokens.engine,tokens.bridge,tokens.audio]) {
      const r=await app.inject({method:'POST',url:'/owner/activities',headers:token?{authorization:`Bearer ${token}`}:{},payload:{invocation_id:'one',objective:'Plan'}});
      assert.equal(r.statusCode,401);
    }
    assert.equal(calls.length,0);
    const rejected=await app.inject({method:'POST',url:'/owner/activities',headers,payload:{invocation_id:'one',objective:'Plan',audience_id:'private'}});
    assert.equal(rejected.statusCode,400);assert.equal(calls.length,0);
    const created=await app.inject({method:'POST',url:'/owner/activities',headers,payload:{invocation_id:'one',objective:'Plan'}});
    assert.equal(created.statusCode,200);assert.equal(created.headers['cache-control'],'no-store');
    assert.deepEqual(calls[0],['assign',principal,{invocation_id:'one',objective:'Plan',max_turns:10}]);
    const page=await app.inject({url:'/owner/activities?limit=5&offset=10',headers});
    assert.equal(page.statusCode,200);assert.deepEqual(calls.at(-1),['list',principal,5,10]);
    for(const url of ['/owner/activities?limit=101','/owner/activities?offset=-1','/owner/activities?audience_id=private','/owner/activities/not-a-uuid']) {
      assert.equal((await app.inject({url,headers})).statusCode,400);
    }
    assert.equal((await app.inject({url:`/owner/activities/${row.id}`,headers})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:`/owner/activities/${row.id}/input`,headers,payload:{expected_version:1,text:'Answer'}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:`/owner/activities/${row.id}/cancel`,headers,payload:{expected_version:1}})).statusCode,200);
    assert.deepEqual(calls.at(-1),['cancel',principal,row.id,1]);
    assert.equal((await app.inject({url:'/owner/activities',headers:{...headers,origin:'https://example.com'}})).statusCode,403);
    // This storage-only slice must never expose autonomous claims or decisions.
    assert.equal((await app.inject({method:'POST',url:'/engine/next_work',headers:{authorization:`Bearer ${tokens.engine}`},payload:{request_id:'x'}})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:'/engine/work_decision',headers:{authorization:`Bearer ${tokens.engine}`},payload:{}})).statusCode,404);
  } finally {await app.close();}
});

test('runtime owner storage stays disabled unless provided; conflicts keep domain error semantics',async()=>{
  const headers={authorization:`Bearer ${tokens.owner}`};
  const disabled=harness();
  try {assert.equal((await disabled.inject({url:'/owner/activities',headers})).statusCode,404);} finally{await disabled.close();}
  const denied=async()=>{throw new DomainError('activity_version_conflict');};
  const app=harness({assign:denied,list:denied,inspect:denied,cancel:denied,provideInput:denied});
  try{
    const r=await app.inject({method:'POST',url:`/owner/activities/${randomUUID()}/cancel`,headers,payload:{expected_version:1}});
    assert.equal(r.statusCode,409);assert.deepEqual(r.json(),{error:'activity_version_conflict'});
  }finally{await app.close();}
});

test('runtime routes share the owner rate budget and deny before storage access',async()=>{
  let accesses=0;
  const runtime: RuntimeOwnerStore={assign:unused,list:async()=>{accesses++;return [];},inspect:unused,cancel:unused,provideInput:unused};
  const app=harness(runtime);
  const headers={authorization:`Bearer ${tokens.owner}`};
  try{
    for(let i=0;i<120;i++)assert.equal((await app.inject({url:i%2?'/owner/activities':'/owner/status',headers})).statusCode,200);
    assert.equal(accesses,60);
    assert.equal((await app.inject({url:'/owner/activities',headers:{...headers,'x-forwarded-for':'1.2.3.4'}})).statusCode,429);
    assert.equal(accesses,60);
  }finally{await app.close();}
});
