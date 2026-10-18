import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewContent, fingerprint, RuntimeProfileSchema, type ContentReviewer } from '../packages/runtime/policy.ts';
import { testProfile, allowTestReviewer } from './fixtures/runtime-policy.ts';

test('policy fingerprints are deterministic and bind instructions, fields and revisions',()=>{
 assert.equal(fingerprint({b:2,a:1}),fingerprint({a:1,b:2}));
 assert.notEqual(fingerprint({checkpoint:'one'}),fingerprint({checkpoint:'two'}));
 assert.equal(RuntimeProfileSchema.safeParse({...testProfile(),max_dispatches_24h:0}).success,false);
 assert.equal(RuntimeProfileSchema.safeParse({...testProfile(),token_budget_24h:undefined}).success,false);
});

test('local secret gate runs before the reviewer and never treats no-match as approval',async()=>{
 let reviewed=0;
 const reviewer:ContentReviewer=async request=>{reviewed++;return allowTestReviewer(request,new AbortController().signal);};
 for(const value of ['-----BEGIN PRIVATE KEY-----','sk-proj-'+'A'.repeat(32),'Bearer '+'B'.repeat(40),'https://user:password@example.com']){
  const r=await reviewContent(testProfile(),'input',{objective:value},reviewer);
  assert.equal(r.verdict,'deny');assert.equal(r.rule_id,'secret_detected');
 }
 assert.equal(reviewed,0);
 const missing=await reviewContent(testProfile(),'input',{objective:'Plan a harmless task'});
 assert.equal(missing.verdict,'needs_review');
 assert.equal((await reviewContent(testProfile(),'input',{objective:'Plan a harmless task'},reviewer)).verdict,'allow');
});

test('review timeout, malformed result, stale hash/version and failures all fail closed',async()=>{
 const reviewers:ContentReviewer[]=[
  async()=>new Promise(()=>{}),async()=>{throw new Error('private error should not be logged');},
  async r=>({verdict:'allow',rule_id:'stale',payload_hash:'0'.repeat(64),policy_version:r.policy_version}),
  async r=>({verdict:'allow',rule_id:'old',payload_hash:r.payload_hash,policy_version:'old'}),
  async()=>({verdict:'allow'} as any),
 ];
 for(const reviewer of reviewers)assert.equal((await reviewContent(testProfile(),'output',{checkpoint:'Plan'},reviewer,5)).verdict,'needs_review');
 assert.equal((await reviewContent(testProfile({max_output_chars:100}),'output',{checkpoint:'x'.repeat(101)},allowTestReviewer)).verdict,'deny');
});
