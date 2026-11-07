import { z } from 'zod';
import type { Principal } from '../domain/policy.ts';
import { DomainError } from '../domain/policy.ts';
import type { RuntimeStore } from '../storage/runtime.ts';
import { RuntimeAuthorizationStore, profileUsable } from '../storage/runtime-authorization.ts';
import { ClaimWorkSchema, WorkDecisionSchema } from './contracts.ts';
import { RuntimeWorkSchema, WorkLeaseSchema, StartWorkSchema, UsageSchema, type RuntimeWork, type PlanningInput } from './protocol.ts';
import { fingerprint, decisionPayload, sourceFingerprint, requestPayload, reviewContent, type ContentReviewer } from './policy.ts';

export interface RuntimeExecutionGate {
 claim(p:Principal,input:unknown):Promise<{work:RuntimeWork|null;reason?:string}>;
 lease(p:Principal,input:unknown):Promise<{valid:boolean}>;
 start(p:Principal,input:unknown):Promise<{allowed:boolean}>;
 decide(p:Principal,input:unknown):Promise<unknown>;
 usage(p:Principal,input:unknown):Promise<unknown>;
 overview?(p:Principal):Promise<unknown>;
 executionEnabled?(p:Principal):Promise<boolean>;
 reviewQueue?(p:Principal):Promise<unknown>;
 retryReview?(p:Principal,input:unknown):Promise<unknown>;
}

/** Default-deny orchestrator. Reviewer and operator profile are explicit trusted dependencies. */
export class RuntimePolicyGate implements RuntimeExecutionGate {
 private runtime:RuntimeStore;private auth:RuntimeAuthorizationStore;private reviewer?:ContentReviewer;private timeoutMs:number;
 constructor(runtime:RuntimeStore,auth:RuntimeAuthorizationStore,reviewer?:ContentReviewer,timeoutMs=2000){this.runtime=runtime;this.auth=auth;this.reviewer=reviewer;this.timeoutMs=timeoutMs;}
 async claim(p:Principal,input:unknown) {
  const b=ClaimWorkSchema.parse(input);const current=await this.auth.profile(p);
  if(!current||!profileUsable(current.profile,Date.now()))return {work:null,reason:'runtime_policy_blocked'};
  const profile=current.profile;
  if(b.engine!==profile.engine||b.model!==profile.model)return {work:null,reason:'runtime_model_mismatch'};
  await this.runtime.reconcile(p);
  // Replays return the original reviewed context, not a freshly assembled prompt.
  const old=await this.auth.replay(p,b.request_id);
  if(old){
   if(!await this.auth.grantValid(p,old.turn_id))return {work:null,reason:'claim_expired'};
   return this.wrap(p,await this.runtime.claim(p,b));
  }
  if(!(await this.auth.budget(p,profile)).allowed)return {work:null,reason:'runtime_resource_budget'};
  const candidate=await this.runtime.preview(p,profile.version);
  if(!candidate)return {work:null,reason:'idle_or_budget_blocked'};
  const a=candidate.activity;
  const modelInput:PlanningInput={activity:{id:a.id,objective:a.objective,origin:a.origin,remaining_turns:a.max_turns-a.turns_used-1,input_reply:a.input_reply??null},
   checkpoint:candidate.checkpoint,audience_id:p.audienceId,wake_reason:candidate.wake_reason,suggested_wakeup_at:new Date(Date.now()+180000).toISOString(),...candidate.context};
  const payload=requestPayload(modelInput,candidate.persona,profile);
  const review=await reviewContent(profile,'input',payload,this.reviewer,this.timeoutMs);
  if(review.verdict!=='allow'){
   await this.auth.hold(p,a,profile,review);return {work:null,reason:review.rule_id};
  }
  const result=await this.runtime.claim(p,b,{profile,profile_hash:current.profile_hash,activity_id:a.id,source_hash:sourceFingerprint(a,candidate.checkpoint,candidate.persona),
   input:modelInput,persona:candidate.persona,input_hash:fingerprint(payload),review});
  return this.wrap(p,result);
 }
 private async wrap(p:Principal,result:Awaited<ReturnType<RuntimeStore['claim']>>) {
  if(!result.work)return {work:null,reason:result.reason};
  const {activity:a,turn:t,checkpoint,wake_reason}=result.work;const g=await this.auth.grant(p,t.id);
  if(!g||!await this.auth.grantValid(p,t.id))return {work:null,reason:'runtime_policy_blocked'};
  return {work:RuntimeWorkSchema.parse({activity:{id:a.id,objective:a.objective,origin:a.origin,version:a.version,max_turns:a.max_turns,turns_used:a.turns_used,input_reply:a.input_reply??null},
   turn:{id:t.id,epoch:t.epoch,lease_token:t.lease_token,lease_until:new Date(t.lease_until).toISOString()},checkpoint,audience_id:p.audienceId,persona:g.persona,wake_reason,
   authorization:{id:g.id,policy_version:g.policy_version,input_hash:g.input_hash,engine:g.engine,model:g.model,max_model_ms:g.max_model_ms},model_input:g.approved_input})};
 }
 async lease(p:Principal,input:unknown) {
  const b=WorkLeaseSchema.parse(input);
  return {valid:(await this.runtime.lease(p,b)).valid&&await this.auth.grantValid(p,b.turn_id)};
 }
 async start(p:Principal,input:unknown){return this.auth.start(p,StartWorkSchema.parse(input));}
 async decide(p:Principal,input:unknown) {
  const b=WorkDecisionSchema.parse(input);const g=await this.auth.decisionGrant(p,b);const current=await this.auth.profile(p);
  if(!g||!current||current.profile.version!==g.policy_version||current.profile_hash!==g.profile_hash||!profileUsable(current.profile,Date.now()))throw new DomainError('runtime_policy_stale');
  const payload=decisionPayload(b);
  if(g.state==='finished'&&g.output_hash===fingerprint(b))return this.runtime.decide(p,b,{grant_id:g.id,profile_version:g.policy_version,profile_hash:g.profile_hash,output_hash:g.output_hash,
   review:{verdict:'allow',rule_id:'receipt_replay',policy_version:g.policy_version,payload_hash:fingerprint(payload)}});
  if(g.state!=='started'||!(await this.runtime.lease(p,{turn_id:b.turn_id,epoch:b.epoch,lease_token:b.lease_token})).valid)throw new DomainError('runtime_approval_invalid');
  const review=await reviewContent(current.profile,'output',payload,this.reviewer,this.timeoutMs);
  if(review.verdict!=='allow'){await this.auth.outputDenied(p,b.turn_id,review);throw new DomainError('runtime_output_blocked');}
  return this.runtime.decide(p,b,{grant_id:g.id,profile_version:g.policy_version,profile_hash:g.profile_hash,output_hash:fingerprint(b),review});
 }
 async reviewQueue(p:Principal){return this.auth.reviewQueue(p);}
 async retryReview(p:Principal,input:unknown){return this.auth.retryReview(p,z.object({request_id:z.uuid(),activity_id:z.uuid(),activity_version:z.number().int().positive(),policy_version:z.string().min(1).max(100),payload_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(input));}
 async executionEnabled(p:Principal){const current=await this.auth.profile(p);return !!this.reviewer&&!!current&&profileUsable(current.profile,Date.now());}
 async overview(p:Principal){return this.auth.overview(p);}
 async usage(p:Principal,input:unknown){return this.auth.usage(p,UsageSchema.parse(input));}
}
