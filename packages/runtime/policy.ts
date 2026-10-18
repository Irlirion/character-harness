import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ACTIVITY_DECIDE_TOOL, PLANNING_INSTRUCTIONS, type PlanningInput } from './protocol.ts';

const identifier=z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/);
export const RuntimeProfileSchema=z.object({
 version:identifier,enabled:z.boolean(),provider_eligible:z.boolean(),reviewed_at:z.iso.datetime({offset:true}),expires_at:z.iso.datetime({offset:true}),
 engine:z.enum(['pi','codex']),model:z.string().min(1).max(200),
 max_input_chars:z.number().int().min(100).max(100000),max_output_chars:z.number().int().min(100).max(20000),
 max_model_ms:z.number().int().min(100).max(75000),max_dispatches_24h:z.number().int().min(1).max(100),
 reserved_tokens:z.number().int().min(1).max(1000000),token_budget_24h:z.number().int().min(1).max(100000000),
}).strict().refine(p=>Date.parse(p.expires_at)>Date.parse(p.reviewed_at),'Invalid review interval');
export type RuntimeProfile=z.infer<typeof RuntimeProfileSchema>;
export type ModelIdentity=Pick<RuntimeProfile,'engine'|'model'>;
export function fingerprint(value:unknown):string {
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function sourceFingerprint(a:any,checkpoint:string|null,persona:string) {
 return fingerprint({id:a.id,version:a.version,objective:a.objective,max_turns:a.max_turns,turns_used:a.turns_used,input_reply:a.input_reply??null,checkpoint,persona});
}
export function requestPayload(input:PlanningInput,persona:string,identity:ModelIdentity) {
 return {input,persona,instructions:PLANNING_INSTRUCTIONS,tool:ACTIVITY_DECIDE_TOOL,engine:identity.engine,model:identity.model};
}
export function requestFingerprint(input:PlanningInput,persona:string,identity:ModelIdentity) {return fingerprint(requestPayload(input,persona,identity));}
export const ReviewResultSchema=z.object({
 verdict:z.enum(['allow','deny','needs_review']),rule_id:identifier,policy_version:identifier,payload_hash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ReviewResult=z.infer<typeof ReviewResultSchema>;
export type ContentReviewer=(request:{phase:'input'|'output';payload:unknown;payload_hash:string;policy_version:string},signal:AbortSignal)=>Promise<ReviewResult>;

/** Only narrow, local secret checks; absence of a match is NOT content approval. */
export function secretDetected(payload:unknown) {
 const s=JSON.stringify(payload);
 return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(s)||/\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,}\b/.test(s)
  ||/\bBearer\s+[a-zA-Z0-9._~+\/-]{20,}/i.test(s)||/https?:\/\/[^\s"/@]+:[^\s"/@]+@/i.test(s);
}
export async function reviewContent(profile:RuntimeProfile,phase:'input'|'output',payload:unknown,reviewer?:ContentReviewer,timeoutMs=2000):Promise<ReviewResult> {
 const payload_hash=fingerprint(payload);
 const result=(verdict:ReviewResult['verdict'],rule_id:string):ReviewResult=>({verdict,rule_id,policy_version:profile.version,payload_hash});
 if(secretDetected(payload))return result('deny','secret_detected');
 if(JSON.stringify(payload).length>(phase==='input'?profile.max_input_chars:profile.max_output_chars))return result('deny','content_size_limit');
 if(!reviewer)return result('needs_review','reviewer_unavailable');
 const stop=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{stop.abort();reject(new Error('review_timeout'));},timeoutMs);});
  const review=ReviewResultSchema.parse(await Promise.race([reviewer({phase,payload,payload_hash,policy_version:profile.version},stop.signal),timeout]));
  if(review.payload_hash!==payload_hash||review.policy_version!==profile.version)return result('needs_review','review_binding_invalid');
  return review;
 }catch{return result('needs_review','review_failed');}
 finally{if(timer)clearTimeout(timer);stop.abort();}
}
export type ApprovedClaim={profile:RuntimeProfile;profile_hash:string;activity_id:string;source_hash:string;input:PlanningInput;persona:string;input_hash:string;review:ReviewResult};
export type ApprovedDecision={grant_id:string;profile_version:string;profile_hash:string;output_hash:string;review:ReviewResult};
