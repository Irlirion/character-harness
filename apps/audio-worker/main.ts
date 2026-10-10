import { coreBaseUrl, coreFetch } from '../../packages/domain/core-http.ts';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { secret } from '../../packages/domain/secrets.ts';
if(process.platform!=='darwin')throw new Error('Audio worker requires macOS');
const base=coreBaseUrl(process.env.CORE_URL??'http://127.0.0.1:3000');
const url=new URL(base);
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Local core required');
const token=secret('AUDIO_TOKEN');
const device=process.env.AUDIO_DEVICE??'Character Harness Voice';
const player=resolve(process.env.AUDIO_PLAYER??'work/voice-spike/harness-audio-play');
const voice=process.env.MACOS_TTS_VOICE??'Milena';
let stopped=false;
let running: ReturnType<typeof spawn>|undefined;
const stop=()=>{stopped=true;running?.kill('SIGTERM');};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const wait=()=>new Promise(r=>setTimeout(r,500));
async function api(path:string,body?:unknown){
 const r=await coreFetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(2000)});
 if(!r.ok)throw new Error('core_request_failed');return r.json();
}
async function processAudio(command:string,args:string[],job:{id:string;claim_id:string;expires_at:string}) {
 const child=spawn(command,args,{stdio:['ignore','ignore','ignore']});running=child;
 let cancelled=false;
 let checking=false;
 const halt=()=>{cancelled=true;child.kill('SIGTERM');};
 const completion=new Promise<void>((resolve,reject)=>{
  child.once('error',reject);
  child.once('exit',code=>code===0&&!cancelled?resolve():reject(new Error(cancelled?'speech_cancelled':'audio_process_failed')));
 });
 const watchdog=setTimeout(halt,Math.min(35000,Math.max(1,new Date(job.expires_at).getTime()-Date.now())));
 const poll=setInterval(()=>{
  if(checking)return;checking=true;
  void api(`/audio/jobs/${job.id}`).then(s=>{if(!s.allowed || stopped)halt();}).catch(halt).finally(()=>{checking=false;});
 },250);
 try{if(stopped)halt();await completion;}finally{clearTimeout(watchdog);clearInterval(poll);running=undefined;}
}
await mkdir('work/audio',{recursive:true});
console.log(JSON.stringify({event:'audio_worker_ready',device}));
while(!stopped){
 let job: {id:string;claim_id:string;text:string;expires_at:string}|undefined;
 let dir:string|undefined;
 try{
  const claimed=await api('/audio/claim',{});job=claimed.job;
  if(!job){await wait();continue;}
  dir=await mkdtemp('work/audio/speech-');const file=resolve(dir,'speech.wav');
  await processAudio('/usr/bin/say',['-v',voice,'-o',file,'--file-format=WAVE','--data-format=LEI16@48000',job.text],job);
  if(stopped)throw new Error('speech_cancelled');
  const state=await api(`/audio/jobs/${job.id}`,{claim_id:job.claim_id,state:'playing'});
  if(state.state!=='playing')throw new Error('speech_cancelled');
  await processAudio(player,[device,file],job);
  await api(`/audio/jobs/${job.id}`,{claim_id:job.claim_id,state:'completed'});
  console.log(JSON.stringify({event:'speech_completed',speech_id:job.id}));
 }catch(e){
  if(job)await api(`/audio/jobs/${job.id}`,{claim_id:job.claim_id,state:stopped?'cancelled':'failed'}).catch(()=>{});
  console.error(JSON.stringify({event:'audio_attempt_failed',error_type:e instanceof Error?e.message:'unknown'}));
  if(!stopped)await wait();
 }finally{if(dir)await rm(dir,{recursive:true,force:true});}
}
