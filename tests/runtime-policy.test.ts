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

test('goal evidence is tied to the active Minecraft session and requires arrival after navigation',async()=>{
 const {UnionClefWorkspace}=await import('../packages/minecraft/unionclef.ts');
 let session='world-one';
 let path={ok:true,busy:true,pos:'0,64,0'};
 const workspace=new UnionClefWorkspace({
  url:'http://localhost:25350/mcp',token:'a'.repeat(40),characterId:'lada',
  access:async()=>({epoch:7,session}),pool:{query:async()=>({rows:[{}],rowCount:1})},
  fetch:async(_url,options)=>{
   const {id,method,params}=JSON.parse(String(options?.body));
   const result=method==='initialize'?{serverInfo:{name:'unionclef'}}:method==='tools/list'
    ?{tools:[{name:'gotoXYZ',inputSchema:{type:'object'}}]}
    :{content:[{type:'text',text:JSON.stringify(params.name==='getGameState'
      ?{inGame:true,self:{pos:'0,64,0',onGround:true,hp:19}}:params.name==='pathStatus'?path:{ok:true})}]};
   return Response.json({id,jsonrpc:'2.0',result});
  }
 });
 const invocation='activity:live-turn';
 assert.equal(await workspace.verifiedGoalStep(invocation,7),false);
 await workspace.observeGoal(invocation,7);
 assert.equal(await workspace.verifiedGoalStep('activity:other-turn',7),false);
 assert.equal(await workspace.verifiedGoalStep(invocation,7,{kind:'grounded',min_health:20}),false);
 assert.equal(await workspace.verifiedGoalStep(invocation,7,{kind:'grounded',min_health:19}),true);
 const arrival={kind:'arrival' as const,x:2,y:64,z:0};
 assert.equal(await workspace.verifiedGoalStep(invocation,7,arrival),false);
 await workspace.recordGoalNavigation(invocation,7,{x:1.2,z:0});
 await workspace.call('gotoXYZ',{x:2,y:64,z:0},invocation,7,async()=>{},true);
 assert.equal(await workspace.verifiedGoalStep(invocation,7),false);
 path={ok:true,busy:false,pos:'2,64,0'};
 assert.equal(await workspace.verifiedGoalStep(invocation,7),false);
 path={ok:true,busy:false,pos:'3,64,0'};
 assert.equal(await workspace.verifiedGoalStep(invocation,7,{...arrival,x:3}),false);
 assert.equal(await workspace.verifiedGoalStep(invocation,7,arrival),true);
 session='world-two';
 assert.equal(await workspace.verifiedGoalStep(invocation,7),false);
});

test('canonical game completion accepts current evidence and never accepts an unverified final report',async()=>{
 const {RuntimePolicyGate}=await import('../packages/runtime/gate.ts');
 const {VERIFIED_GOAL_SUMMARY}=await import('../packages/runtime/protocol.ts');
 const {randomUUID}=await import('node:crypto');
 const profile=testProfile();
 const plan={goal:'Build a house',steps:['Floor','Walls','Roof'],completed:1,observation:'Floor built',criteria:
  ['floor','walls','roof'].map(phase=>({kind:'house',phase,size:'7x5',x:0,y:64,z:0}))};
 const grant={id:randomUUID(),state:'started',policy_version:profile.version,profile_hash:fingerprint(profile),
  approved_input:{minecraft_goal:true,minecraft_build:'wooden_house',checkpoint:JSON.stringify(plan)}};
 let evidence=false, reviewerCalls=0;
 let persisted:unknown;
 const store={lease:async()=>({valid:true}),decide:async(_p:unknown,b:unknown,approval:any)=>{persisted=b;return approval.review.rule_id}};
 const auth={decisionGrant:async()=>grant,profile:async()=>({profile,profile_hash:grant.profile_hash})};
 const gate=new RuntimePolicyGate(store as any,auth as any,async request=>{
  reviewerCalls++;
  return {...request,verdict:'needs_review',rule_id:'kev_needs_review'};
 },2000,undefined,async()=>evidence);
 const principal={characterId:'lada',audienceId:'demo-public'};
 const report={invocation_id:'test',turn_id:randomUUID(),lease_token:randomUUID(),epoch:7,expected_version:2,
  checkpoint:JSON.stringify({...plan,completed:3,observation:VERIFIED_GOAL_SUMMARY}),
  decision:{action:'complete',summary:VERIFIED_GOAL_SUMMARY}};
 const intermediate={...report,checkpoint:JSON.stringify({...plan,completed:2,observation:'Arbitrary model text'}),
  decision:{action:'continue'}};
 await assert.rejects(gate.decide(principal,intermediate),/minecraft_goal_progress_unconfirmed/);
 await assert.rejects(gate.decide(principal,report),/minecraft_goal_progress_invalid/);
 evidence=true;
 assert.equal(await gate.decide(principal,intermediate),'minecraft_goal_step_verified');
 assert.doesNotMatch(JSON.stringify(persisted),/Arbitrary model text/);
 grant.approved_input.checkpoint=JSON.stringify({...plan,completed:2});
 evidence=false;
 await assert.rejects(gate.decide(principal,report),/minecraft_goal_completion_unconfirmed/);
 evidence=true;
 await assert.rejects(gate.decide(principal,{...report,decision:{action:'complete',summary:'Unreviewed model output'}}),/minecraft_goal_completion_unconfirmed/);
 assert.equal(await gate.decide(principal,report),'minecraft_goal_steps_verified');
 assert.equal(reviewerCalls,0);
 // A pre-existing unsupported goal must not be declared complete even when
 // the last observation is valid: ground checks cannot prove a diamond was mined.
 const legacy={goal:'Mine a diamond',steps:['Look around','Mine a diamond'],completed:1,observation:'Ready',criteria:[
  {kind:'grounded',min_health:1},{kind:'grounded',min_health:1}]};
 grant.approved_input={minecraft_goal:true,checkpoint:JSON.stringify(legacy)} as typeof grant.approved_input;
 await assert.rejects(gate.decide(principal,{...report,checkpoint:JSON.stringify({...legacy,completed:2,observation:VERIFIED_GOAL_SUMMARY})}),/minecraft_goal_criteria_unsupported/);
});

test('navigation goals describe only what their criteria can verify',async()=>{
 const {canonicalNavigationGoal}=await import('../packages/runtime/protocol.ts');
 const plan={goal:'Mine a diamond',steps:['Observe','Mine a diamond'],completed:0,observation:'',criteria:[
  {kind:'grounded' as const,min_health:1},{kind:'arrival' as const,x:5,y:64,z:9,radius:1}]};
 const canonical=canonicalNavigationGoal(plan);
 assert.ok(canonical);
 assert.doesNotMatch(JSON.stringify(canonical),/diamond/);
 assert.match(canonical.goal,/5, 64, 9/);
});
