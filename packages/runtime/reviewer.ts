import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { fingerprint, ReviewResultSchema, type ContentReviewer } from './policy.ts';

/** Operator configuration, never agent-controlled. The bridge is trusted code, not a sandbox. */
export const ReviewerConfigSchema=z.object({
 executable:z.string().refine(isAbsolute),args:z.array(z.string().max(1000)).max(20).default([]),
 cwd:z.string().refine(isAbsolute),policy_versions:z.array(z.string().min(1).max(100)).min(1).max(20),
 rules:z.string().min(100).max(30000),rules_hash:z.string().regex(/^[a-f0-9]{64}$/),
 privacy_reviewed:z.literal(true),expires_at:z.iso.datetime({offset:true}),
 timeout_ms:z.number().int().min(100).max(60000),max_requests_24h:z.number().int().min(1).max(1000),
}).strict();
export type ReviewerConfig=z.infer<typeof ReviewerConfigSchema>;
export type ReviewPermit=(signal:AbortSignal,binding:{policy_version:string;rules_hash:string})=>Promise<boolean>;

export function createProcessReviewer(input:unknown,permit:ReviewPermit):ContentReviewer {
 const config=ReviewerConfigSchema.parse(input);
 if(fingerprint(config.rules)!==config.rules_hash)throw new Error('reviewer_rules_integrity');
 let busy=false;
 return async(request,signal)=>{
  const blocked=(rule_id:string)=>({verdict:'needs_review' as const,rule_id,policy_version:request.policy_version,payload_hash:request.payload_hash});
  if(signal.aborted)return blocked('reviewer_aborted');
  if(Date.parse(config.expires_at)<=Date.now()||!config.policy_versions.includes(request.policy_version))return blocked('reviewer_configuration_stale');
  if(busy)return blocked('reviewer_busy');
  busy=true;
  try {
   if(!await permit(signal,{policy_version:request.policy_version,rules_hash:config.rules_hash}))return blocked('reviewer_budget');
   signal.throwIfAborted();
   if(Date.parse(config.expires_at)<=Date.now())return blocked('reviewer_configuration_stale');
   // Explicit minimal environment: no core tokens, database URL, API keys or user home.
   return await new Promise((resolve,reject)=>{
    const child=spawn(config.executable,config.args,{cwd:config.cwd,env:{LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32'});
    let output='',bytes=0,done=false;
    const end=(error?:Error)=>{
     if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
     // On Unix the trusted bridge and its App Server share a private process group.
     try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{child.kill('SIGKILL');}
     if(error){reject(error);return;}
     try{
      const result=ReviewResultSchema.parse(JSON.parse(output));
      if(result.payload_hash!==request.payload_hash||result.policy_version!==request.policy_version)throw new Error('reviewer_binding');
      resolve(result);
     }catch{reject(new Error('reviewer_invalid_response'));}
    };
    const abort=()=>end(new Error('reviewer_aborted'));
    const timer=setTimeout(()=>end(new Error('reviewer_timeout')),config.timeout_ms);
    signal.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4096)end(new Error('reviewer_response_limit'));else output+=chunk.toString('utf8');});
    child.stderr.resume(); // Never expose provider diagnostics or payloads.
    child.on('error',()=>end(new Error('reviewer_unavailable')));
    child.stdin.on('error',()=>end(new Error('reviewer_unavailable')));
    child.on('close',code=>end(code===0?undefined:new Error('reviewer_failed')));
    if(signal.aborted){abort();return;}
    child.stdin.end(JSON.stringify({protocol:'runtime-review.v1',rules:config.rules,rules_hash:config.rules_hash,...request})+'\n');
   });
  } finally {busy=false;}
 };
}
export async function loadReviewerConfig(path:string|undefined){return path?ReviewerConfigSchema.parse(JSON.parse(await readFile(path,'utf8'))):undefined;}
