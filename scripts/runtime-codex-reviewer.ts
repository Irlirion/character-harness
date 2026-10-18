import { readFile,realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute,relative,sep } from 'node:path';
import { z } from 'zod';
import { CodexRpc } from '../packages/codex/rpc.ts';
import { REVIEWER_CODEX_CONFIG,runCodexReview,ReviewerEnvelopeSchema } from '../packages/runtime/codex-reviewer.ts';

const Config=z.object({binary:z.string().refine(isAbsolute),binary_sha256:z.string().regex(/^[a-f0-9]{64}$/),home:z.string().refine(isAbsolute),cwd:z.string().refine(isAbsolute),
 model:z.string().min(1).max(200),native_tools_verified:z.literal(true),provider_eligible:z.literal(true),privacy_reviewed:z.literal(true),expires_at:z.iso.datetime({offset:true}),timeout_ms:z.number().int().min(100).max(55000)}).strict();
let rpc:CodexRpc|undefined;
try{
 const config=Config.parse(JSON.parse(await readFile(process.argv[2],'utf8')));
 const home=await realpath(config.home),cwd=await realpath(config.cwd);
 const outside=(a:string,b:string)=>{const rel=relative(a,b);return rel.startsWith('..'+sep)||rel==='..'||isAbsolute(rel);};
 if(!outside(home,cwd)||!outside(cwd,home))throw new Error('reviewer_directory_overlap');
 if(Date.parse(config.expires_at)<=Date.now())throw new Error('reviewer_attestation_expired');
 if(createHash('sha256').update(await readFile(config.binary)).digest('hex')!==config.binary_sha256)throw new Error('reviewer_binary_changed');
 if(await readFile(config.home+'/config.toml','utf8')!==REVIEWER_CODEX_CONFIG)throw new Error('reviewer_config_changed');
 let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>200000)throw new Error('reviewer_input_limit');}
 const input=ReviewerEnvelopeSchema.parse(JSON.parse(raw));
 const signal=AbortSignal.timeout(config.timeout_ms);
 rpc=new CodexRpc(config.binary,config.cwd,config.home);
 const {abortable}=await import('../packages/runtime/consumer.ts');
 await abortable(rpc.initialize(),signal);
 const account=await abortable(rpc.request('account/read',{refreshToken:false}),signal);
 if(account.account?.type!=='chatgpt')throw new Error('reviewer_login_required');
 const models=await abortable(rpc.request('model/list',{}),signal);
 if(!models.data?.some((m:any)=>(m.model??m.id)===config.model))throw new Error('reviewer_model_unavailable');
 const result=await runCodexReview(rpc,config.cwd,config.model,input,signal);
 process.stdout.write(JSON.stringify(result)+'\n');
}catch{process.exitCode=1;}finally{if(rpc){rpc.close();const child=rpc.child;const timer=setTimeout(()=>child.kill('SIGKILL'),250);child.once('exit',()=>clearTimeout(timer));}}
