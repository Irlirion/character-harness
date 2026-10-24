import {groupDirectoryServer} from '../../packages/telegram/directory-server.ts';
import { attemptDelivery } from '../../packages/telegram/delivery.ts';
import { randomUUID } from 'node:crypto';
import { BotApi, BotApiError } from '../../packages/telegram/api.ts';
import { coreBaseUrl, coreFetch } from '../../packages/domain/core-http.ts';
import { secret } from '../../packages/domain/secrets.ts';
const bot=new BotApi(secret('TELEGRAM_BOT_TOKEN'));
const base=coreBaseUrl(process.env.CORE_URL??'http://core:3000');
const headers={Authorization:`Bearer ${secret('TELEGRAM_WORKER_TOKEN')}`,'Content-Type':'application/json'};
const owner=randomUUID();let stopped=false;
const controller=new AbortController();
process.once('SIGTERM',()=>{stopped=true;controller.abort();});
process.once('SIGINT',()=>{stopped=true;controller.abort();});
const sleep=async(ms:number)=>{try{await new Promise<void>(resolve=>{
 const timer=setTimeout(done,ms);function done(){clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();}
 controller.signal.addEventListener('abort',done,{once:true});if(stopped)done();
});}catch{}};
class WorkerCoreError extends Error {}
async function core(path:string,body:unknown):Promise<any> {
 const r=await coreFetch(base+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 if(!r.ok) {
  const error=await r.json().catch(()=>({}));
  const known=['poller_busy','poller_lease_expired','event_queue_full','bot_identity_changed','rate_limit_exceeded'];
  throw new WorkerCoreError(known.includes(error.error)?error.error:'core_request_failed');
 }
 return r.json();
}
// Keep only supported fields. Large media/service payloads are acknowledged as ignored.
function envelope(u:any) {
 const m=u.message;
 return {update_id:u.update_id,my_chat_member:u.my_chat_member?{chat:{id:u.my_chat_member.chat?.id,type:u.my_chat_member.chat?.type,title:u.my_chat_member.chat?.title,username:u.my_chat_member.chat?.username},new_chat_member:{status:u.my_chat_member.new_chat_member?.status}}:undefined,
  message:m && typeof m.text==='string' && m.text.length<=4000 ? {
   message_id:m.message_id,date:m.date,text:m.text,from:m.from?{id:m.from.id,is_bot:m.from.is_bot}:undefined,
   chat:{id:m.chat?.id,type:m.chat?.type,title:m.chat?.title,username:m.chat?.username,is_forum:m.chat?.is_forum},sender_chat:m.sender_chat?{}:undefined,
   message_thread_id:m.message_thread_id,is_automatic_forward:m.is_automatic_forward,
   entities:Array.isArray(m.entities)?m.entities.slice(0,100):[],
   reply_to_message:m.reply_to_message?{message_id:m.reply_to_message.message_id,from:{id:m.reply_to_message.from?.id}}:undefined
  }:undefined};
}
let me:any;
while(!stopped && !me) {
 try {me=await bot.call('getMe');await core('/telegram/register',{bot_id:String(me.id),username:me.username});}
 catch(e){me=undefined;console.error(JSON.stringify({event:'telegram_start_failed',code:e instanceof BotApiError?e.code:e instanceof WorkerCoreError?e.message:'core_unavailable'}));await sleep(10000);}
}
if(me) {
 const botId=String(me.id);
 const directory=groupDirectoryServer(bot,secret('TELEGRAM_WORKER_TOKEN'));
 directory.listen(3001,'0.0.0.0');
 controller.signal.addEventListener('abort',()=>{directory.closeAllConnections();directory.close();},{once:true});
 console.log(JSON.stringify({event:'telegram_started',bot_id:botId}));
 async function setState(state:string){await core('/telegram/state',{bot_id:botId,owner,state}).catch(()=>{});}
 async function poll() {
  let backoff=1000;
  while(!stopped) {
   try {
    const lease=await core('/telegram/poll',{bot_id:botId,owner});
    const webhook=await bot.call('getWebhookInfo');
    if(webhook.url){await setState('configuration_error');await sleep(30000);continue;}
    await setState('connected');
    const updates=await bot.call('getUpdates',{offset:Number(lease.offset),timeout:25,limit:10,allowed_updates:['message','my_chat_member']});
    if(!updates.length)await core('/telegram/updates',{bot_id:botId,owner,updates:[]});
    if(updates.length)console.log(JSON.stringify({event:'telegram_updates_received',count:updates.length}));
    for(const u of updates) {if(stopped)break;await core('/telegram/updates',{bot_id:botId,owner,updates:[envelope(u)]});}
    backoff=1000;
   }catch(e){
    await setState(e instanceof BotApiError && e.code==='unauthorized'?'auth_required':'disconnected');
    console.error(JSON.stringify({event:'telegram_poll_failed',code:e instanceof BotApiError?e.code:e instanceof WorkerCoreError?e.message:'core_unavailable'}));
    await sleep(e instanceof BotApiError && e.retryAfter?e.retryAfter*1000:backoff);backoff=Math.min(30000,backoff*2);
   }
  }
 }
 async function send() {
  while(!stopped) {
   let job:any;
   try {
    job=(await core('/telegram/claim',{bot_id:botId,owner})).job;
    if(stopped){
     if(job)await core(`/telegram/deliveries/${job.id}`,{claim_id:job.claim_id,state:'retry_wait',retry_after:1});
     break;
    }
    if(!job){await sleep(1000);continue;}
    if(job.bot_id!==botId)throw new Error('bot_identity_mismatch');
    const outcome=await attemptDelivery(bot,job);
    console.log(JSON.stringify({event:'telegram_delivery',job_id:job.id,kind:job.image?'photo':'text',state:outcome.state}));
    if(outcome.error_code==='unauthorized')await setState('auth_required');
    // If reporting fails, never resend. Core recovers the sending lease as unknown.
    await core(`/telegram/deliveries/${job.id}`,{claim_id:job.claim_id,...outcome});
   }catch{console.error(JSON.stringify({event:'telegram_delivery_failed',code:'core_or_transport_unavailable'}));await sleep(3000);}
  }
 }
 await Promise.all([poll(),send()]);
}
