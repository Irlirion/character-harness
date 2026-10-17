import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpdate, parseTelegramDecision } from '../packages/telegram/domain.ts';
import { BotApi, BotApiError } from '../packages/telegram/api.ts';
const update=(extra:any={})=>({update_id:1,message:{message_id:4,date:1700000000,from:{id:8,is_bot:false},chat:{id:-42,type:'supergroup'},text:'Привет, @LadaBot',entities:[{type:'mention',offset:8,length:8}],...extra}});
test('Telegram normalization preserves numeric identities and recognizes mentions and replies',()=>{
 const m=normalizeUpdate(update(),'99','LadaBot')!;
 assert.equal(m.chatId,'-42');assert.equal(m.authorId,'telegram:8');assert.equal(m.direct,true);
 assert.equal(normalizeUpdate(update({text:'привет',entities:[],reply_to_message:{message_id:2,from:{id:99}}}),'99','LadaBot')!.direct,true);
 assert.equal(normalizeUpdate(update({text:'@LadaBot',entities:[]}),'99','LadaBot')!.direct,false,'plain name does not forge a Telegram mention');
});
test('unsupported Telegram messages never wake the agent',()=>{
 for(const extra of [{from:{id:1,is_bot:true}},{chat:{id:-1,type:'channel'}},{sender_chat:{id:-2}},{message_thread_id:3},{chat:{id:-1,type:'supergroup',is_forum:true}},{text:'a'.repeat(4001)},{from:{id:Number.MAX_SAFE_INTEGER+2}},{text:''}]) assert.equal(normalizeUpdate(update(extra),'99','LadaBot'),null);
 assert.equal(normalizeUpdate({edited_message:update().message},'99','LadaBot'),null);
});
test('reply/silence contract is strict and silence is group-only',()=>{
 assert.deepEqual(parseTelegramDecision('{"decision":"silence"}',true),{decision:'silence'});
 assert.deepEqual(parseTelegramDecision('{"decision":"silence","text":null}',true),{decision:'silence'});
 assert.throws(()=>parseTelegramDecision('{"decision":"silence","text":"explanation"}',true));
 assert.deepEqual(parseTelegramDecision('{"decision":"reply","text":"Привет"}',false),{decision:'reply',text:'Привет'});
 for(const raw of ['plain reply','{"decision":"silence"}','{"decision":"reply","text":""}','{"decision":"reply","text":"ok","chat_id":1}']) assert.throws(()=>parseTelegramDecision(raw,false));
});
test('Bot API reports bounded classifications without token, URL or Telegram descriptions',async()=>{
 const token='123:private_test_secret';
 for(const [status,payload,code] of [[429,{ok:false,error_code:429,parameters:{retry_after:7}},'rate_limited'],[401,{ok:false,error_code:401,description:token},'unauthorized'],[403,{ok:false,error_code:403},'forbidden'],[400,{ok:false,error_code:400},'rejected'],[502,{ok:false},'unknown']] as const) {
  const api=new BotApi(token,(async()=>new Response(JSON.stringify(payload),{status})) as typeof fetch);
  await assert.rejects(api.call('sendMessage',{text:'private'}),(e:any)=>{
   assert.ok(e instanceof BotApiError);assert.equal(e.code,code);assert.ok(!String(e).includes(token));
   if(code==='rate_limited')assert.equal(e.retryAfter,7);return true;
  });
 }
 const api=new BotApi(token,(async()=>{throw new Error(`request https://example/${token}`);}) as typeof fetch);
 await assert.rejects(api.call('sendMessage'),(e:any)=>e.code==='unknown' && !String(e).includes(token));
});
test('Bot API uses POST JSON, disallows redirects and sends reply parameters intact',async()=>{
 let call:any;
 const api=new BotApi('123:test',(async(url,options)=>{call={url,options};return Response.json({ok:true,result:{message_id:7}});}) as typeof fetch);
 assert.deepEqual(await api.call('sendMessage',{chat_id:'-42',reply_parameters:{message_id:4},text:'привет'}),{message_id:7});
 assert.equal(call.options.redirect,'error');assert.equal(call.options.method,'POST');
 assert.equal(JSON.parse(call.options.body).chat_id,'-42');
});

test('delivery makes exactly one external attempt and preserves ambiguity',async()=>{
 const {attemptDelivery}=await import('../packages/telegram/delivery.ts');
 let calls=0;
 const job={chat_id:'-42',text:'Привет',reply_to:'7'};
 const unknown=await attemptDelivery({call:async()=>{calls++;throw new Error('socket closed after send');}},job);
 assert.equal(calls,1);assert.deepEqual(unknown,{state:'unknown',error_code:'unknown'});
 assert.deepEqual(await attemptDelivery({call:async()=>{throw new BotApiError('rate_limited',12);}},job),{state:'retry_wait',error_code:'rate_limited',retry_after:12});
 assert.deepEqual(await attemptDelivery({call:async()=>({message_id:42})},job),{state:'sent',message_id:'42'});
});
