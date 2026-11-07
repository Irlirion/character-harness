import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeImage} from '../packages/images/domain.ts';
import {BotApi} from '../packages/telegram/api.ts';
import {attemptDelivery} from '../packages/telegram/delivery.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=','base64');
test('generated media bounds and canonical base64',()=>{
 assert.deepEqual(decodeImage(png.toString('base64')),png);
 for(const data of ['',Buffer.from('not an image').toString('base64'),png.toString('base64')+'\n','A'.repeat(14_000_004)])assert.throws(()=>decodeImage(data));
 const huge=Buffer.from(png);huge.writeUInt32BE(99999,16);assert.throws(()=>decodeImage(huge.toString('base64')));
});
test('photo delivery uses multipart, scoped reply, no generation or automatic resend',async()=>{
 let count=0;
 const transport:typeof fetch=async(url,init)=>{
  count++;assert.match(String(url),/\/sendPhoto$/);
  assert.equal(init?.headers,undefined);
  const form=init?.body as FormData;assert.equal(form.get('chat_id'),'-8');assert.equal(form.get('caption'),'Лада');
  assert.deepEqual(JSON.parse(String(form.get('reply_parameters'))),{message_id:7,allow_sending_without_reply:true});
  const photo=form.get('photo') as File;assert.equal(photo.type,'image/png');assert.deepEqual(Buffer.from(await photo.arrayBuffer()),png);
  return Response.json({ok:true,result:{message_id:10}});
 };
 const bot=new BotApi('99:test',transport);
 assert.deepEqual(await attemptDelivery(bot,{chat_id:'-8',reply_to:'7',text:'Лада',image:png.toString('base64')}),{state:'sent',message_id:'10'});
 assert.equal(count,1);
 const failed=new BotApi('99:test',async()=>{count++;throw Error('network secret');});
 assert.deepEqual(await attemptDelivery(failed,{chat_id:'-8',reply_to:'7',text:'',image:png.toString('base64')}),{state:'unknown',error_code:'unknown'});
 assert.equal(count,2);
});
