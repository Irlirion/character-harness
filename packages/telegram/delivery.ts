import { decodeImage } from '../images/domain.ts';
import { BotApiError } from './api.ts';
import type { BotApi } from './api.ts';
export type DeliveryOutcome = {
 state:'sent'|'retry_wait'|'failed'|'unknown'; message_id?:string;
 retry_after?:number; error_code?:BotApiError['code'];
};
/** One external attempt only. Reporting/retries belong to the durable core outbox. */
export async function attemptDelivery(bot:Pick<BotApi,'call'>,job:{chat_id:string;text:string;reply_to:string|null;image?:string}):Promise<DeliveryOutcome> {
 try {
  const sent=job.image?await bot.call('sendPhoto',{chat_id:job.chat_id,photo:decodeImage(job.image),caption:job.text.slice(0,1024),...(job.reply_to?{reply_parameters:{message_id:Number(job.reply_to),allow_sending_without_reply:true}}:{})}):await bot.call('sendMessage',{chat_id:job.chat_id,text:job.text,
   ...(job.reply_to?{reply_parameters:{message_id:Number(job.reply_to),allow_sending_without_reply:true}}:{}),link_preview_options:{is_disabled:true}});
  if(!Number.isSafeInteger(sent?.message_id))throw new BotApiError('unknown');
  return {state:'sent',message_id:String(sent.message_id)};
 } catch(e) {
  const err=e instanceof BotApiError?e:new BotApiError('unknown');
  return {state:err.code==='rate_limited'?'retry_wait':err.code==='unknown'?'unknown':'failed',error_code:err.code,
   ...(err.retryAfter?{retry_after:err.retryAfter}:{})};
 }
}
