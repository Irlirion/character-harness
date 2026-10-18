import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createProcessReviewer } from '../packages/runtime/reviewer.ts';
import { fingerprint,reviewContent } from '../packages/runtime/policy.ts';
import { testProfile } from './fixtures/runtime-policy.ts';
const rules='Synthetic fixture rules for testing only. '.repeat(4);
const config=(mode='ok')=>({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-reviewer-child.mjs',import.meta.url)),mode],cwd:'/private/tmp',rules,rules_hash:fingerprint(rules),policy_versions:['test.v1'],privacy_reviewed:true,expires_at:new Date(Date.now()+60000).toISOString(),timeout_ms:2000,max_requests_24h:10});
const req={phase:'input' as const,payload:{text:'safe'},payload_hash:fingerprint({text:'safe'}),policy_version:'test.v1'};
test('review bridge validates config, binding and strict bounded response',async()=>{
 let permits=0;const permit=async()=>{permits++;return true;};
 assert.throws(()=>createProcessReviewer({...config(),rules_hash:'0'.repeat(64)},permit));
 assert.throws(()=>createProcessReviewer({...config(),privacy_reviewed:false},permit));
 const review=await createProcessReviewer(config(),permit)(req,new AbortController().signal);
 assert.equal(review.verdict,'allow');assert.equal(permits,1);
 for(const mode of ['wrong','bad','large','fail','hang']){
  const verdict=await reviewContent(testProfile(),'input',req.payload,createProcessReviewer({...config(mode),timeout_ms:mode==='hang'?100:2000},permit),3000);
  assert.equal(verdict.verdict,'needs_review',mode);
 }
});
test('stale, wrong policy, budget denial and pre-abort never launch bridge',async()=>{
 let permits=0;const permit=async()=>{permits++;return true;};
 for(const change of [{expires_at:'2020-01-01T00:00:00Z'},{policy_versions:['other']}]){
  assert.equal((await createProcessReviewer({...config(),...change},permit)(req,new AbortController().signal)).rule_id,'reviewer_configuration_stale');
 }
 assert.equal(permits,0);
 assert.equal((await createProcessReviewer(config(),async()=>false)(req,new AbortController().signal)).rule_id,'reviewer_budget');
 assert.equal((await createProcessReviewer(config(),permit)(req,AbortSignal.abort())).rule_id,'reviewer_aborted');assert.equal(permits,0);
});
test('review bridge serializes work and cancellation releases its slot',async()=>{
 const review=createProcessReviewer({...config('hang'),timeout_ms:1000},async()=>true),stop=new AbortController();
 const first=review(req,stop.signal);await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal((await review(req,new AbortController().signal)).rule_id,'reviewer_busy');
 stop.abort();await assert.rejects(first,/reviewer_aborted/);
});

test('review workflow routes require owner role and never expose an approval endpoint',async()=>{
 const {runtimeApp,runtimeTokens,runtimePrincipal}=await import('./fixtures/runtime-app.ts');
 const {RuntimePolicyGate}=await import('../packages/runtime/gate.ts');
 const {randomUUID}=await import('node:crypto');
 const calls:unknown[]=[];
 const policy=new RuntimePolicyGate({} as any,{reviewQueue:async(p:unknown)=>{calls.push(p);return [{rule_id:'reviewer_unavailable'}];},retryReview:async(p:unknown,b:unknown)=>{calls.push({p,b});return {queued:true};}} as any);
 const app=runtimeApp({runtimeEngine:{} as any,runtimePolicy:policy});
 try{
  const payload={request_id:randomUUID(),activity_id:randomUUID(),activity_version:1,policy_version:'test.v1',payload_hash:'a'.repeat(64)};
  for(const token of [runtimeTokens.engine,runtimeTokens.audio,runtimeTokens.bridge]){
   const headers={authorization:`Bearer ${token}`};
   assert.equal((await app.inject({url:'/owner/runtime-reviews',headers})).statusCode,401);
   assert.equal((await app.inject({method:'POST',url:'/owner/runtime-reviews/retry',headers,payload})).statusCode,401);
  }
  assert.equal(calls.length,0);
  const headers={authorization:`Bearer ${runtimeTokens.owner}`};
  const queue=await app.inject({url:'/owner/runtime-reviews',headers});assert.equal(queue.statusCode,200);assert.equal(queue.headers['cache-control'],'no-store');assert.deepEqual(calls[0],runtimePrincipal);
  const retried=await app.inject({method:'POST',url:'/owner/runtime-reviews/retry',headers,payload});assert.equal(retried.statusCode,200);assert.equal(retried.headers['cache-control'],'no-store');
  assert.equal((await app.inject({method:'POST',url:'/owner/runtime-reviews/retry',headers,payload:{...payload,verdict:'allow'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/owner/runtime-reviews/approve',headers,payload})).statusCode,404);
  assert.equal((await app.inject({url:'/owner/runtime-reviews',headers:{...headers,origin:'https://example.com'}})).statusCode,403);
 }finally{await app.close();}
});


test('Unix reviewer bridge kills surviving descendants after successful exit',{skip:process.platform==='win32'},async()=>{
 const {mkdtemp,access,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(tmpdir()+'/review-group-'),marker=dir+'/marker';
 try{
  const c=config('descendant');c.args.push(marker);
  assert.equal((await createProcessReviewer(c,async()=>true)(req,new AbortController().signal)).verdict,'allow');
  await new Promise(resolve=>setTimeout(resolve,600));await assert.rejects(access(marker));
 }finally{await rm(dir,{recursive:true,force:true});}
});
