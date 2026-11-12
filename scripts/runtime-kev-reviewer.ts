import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { fingerprint, ReviewResultSchema } from '../packages/runtime/policy.ts';

const request = ReviewResultSchema.pick({policy_version:true,payload_hash:true}).extend({
  protocol:z.literal('runtime-review.v1'), phase:z.enum(['input','output']),
  rules:z.string(), rules_hash:z.string(), payload:z.unknown(), scope:z.enum(['minecraft_checkpoint','minecraft_goal_input']).optional()
});

const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 160_000) throw new Error('review_request_too_large');
  chunks.push(chunk);
}
const input = request.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
if (fingerprint(input.rules)!==input.rules_hash || fingerprint(input.payload)!==input.payload_hash)
  throw new Error('review_request_integrity');

const url = new URL(process.argv[2]);
if (url.protocol!=='http:' || !['host.docker.internal','127.0.0.1','localhost'].includes(url.hostname))
  throw new Error('reviewer_must_be_local');

const internalCheckpoint=input.phase==='output'&&input.scope==='minecraft_checkpoint';
const gameInput=input.phase==='input'&&input.scope==='minecraft_goal_input';
const reviewQuestion=internalCheckpoint||gameInput
  ? {type:'noul',instructions:input.rules+(gameInput?readFileSync(new URL('./kev-input.md',import.meta.url),'utf8'):readFileSync(new URL('./kev-output.md',import.meta.url),'utf8')),criteria:{
      true:'Ordinary permitted Minecraft goal or progress, without sensitive or prohibited content.',
      false:'A policy violation, sensitive disclosure, or materially unclear scope.'
    }}
  : {type:'choice',instructions:input.rules,criteria:{
      allow:'Clearly within policy and scope.',
      deny:'Clear violation of the operator rules.',
      needs_review:'Unclear scope, ambiguous risk or insufficient evidence.'
    }};

const response = await fetch(new URL('/v1/systemone',url), {
  method:'POST', redirect:'error', signal:AbortSignal.timeout(9000),
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    state:{phase:input.phase,payload:input.payload},
    questions:{review:reviewQuestion}
  })
});
if (!response.ok) throw new Error('kev_review_failed');
const probabilities = z.object({allow:z.number().min(0).max(1),deny:z.number().min(0).max(1),needs_review:z.number().min(0).max(1)});
const result=await response.json();
let verdict: 'allow'|'deny'|'needs_review';
if(internalCheckpoint||gameInput){
  const score=z.object({answers:z.object({review:z.object({noul:z.number().min(0).max(1)})})}).parse(result).answers.review.noul;
  verdict=score>=0.60?'allow':'needs_review';
}else{
  const scores=z.object({answers:z.object({review:z.object({probabilities})})}).parse(result).answers.review.probabilities;
  if(Math.abs(scores.allow+scores.deny+scores.needs_review-1)>0.01)throw new Error('kev_invalid_scores');
  verdict=scores.allow>=0.60?'allow':scores.deny>=0.80?'deny':'needs_review';
}
process.stdout.write(JSON.stringify({
  verdict,rule_id:`kev_${verdict}`,policy_version:input.policy_version,payload_hash:input.payload_hash
})+'\n');
