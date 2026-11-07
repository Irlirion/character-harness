import { randomUUID } from 'node:crypto';
import { planningInput, type RuntimeWork } from '../../packages/runtime/protocol.ts';
import { requestFingerprint, type RuntimeProfile, type ContentReviewer, type ModelIdentity } from '../../packages/runtime/policy.ts';
export const testIdentity:ModelIdentity={engine:'codex',model:'model'};
export function testProfile(change:Partial<RuntimeProfile>={}):RuntimeProfile {
 return {version:'test.v1',enabled:true,provider_eligible:true,reviewed_at:new Date(Date.now()-10000).toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),
  engine:'codex',model:'model',max_input_chars:50000,max_output_chars:20000,max_model_ms:75000,max_dispatches_24h:100,reserved_tokens:1000,token_budget_24h:100000,...change};
}
export const allowTestReviewer:ContentReviewer=async request=>({verdict:'allow',rule_id:'synthetic_test_only',policy_version:request.policy_version,payload_hash:request.payload_hash});
export function approveTestWork(w:RuntimeWork,identity=testIdentity):RuntimeWork {
 const model_input=planningInput(w);
 return {...w,model_input,authorization:{id:randomUUID(),policy_version:'test.v1',input_hash:requestFingerprint(model_input,w.persona,identity),...identity,max_model_ms:75000}};
}
