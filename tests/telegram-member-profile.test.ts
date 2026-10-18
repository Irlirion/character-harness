import test from 'node:test';import assert from 'node:assert/strict';import {fetchMemberProfile} from '../packages/telegram/member-profile.ts';import {BotApi,BotApiError} from '../packages/telegram/api.ts';import {codexProfileToolResult,profileToolContent} from '../packages/telegram/profile-tool-content.ts';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
const member=(id=2,name='Миша',username='misha')=>({status:'member',user:{id,first_name:name,username}});
test('profile resolves only known group member and returns bounded available bio/avatar without IDs',async()=>{
 const calls:any[]=[];const bot={call:async(method:string,body:any)=>{calls.push({method,body});if(method==='getChatAdministrators')return [];if(method==='getChatMember')return member();if(method==='getChat')return {id:2,type:'private',bio:'Люблю строить',phone_number:'DO_NOT_DISCLOSE'};return {total_count:1,photos:[[{file_id:'photo',width:100,height:100,file_size:100}]]};},downloadProfilePhoto:async()=>({mime:'image/png' as const,data:png})};
 const p=await fetchMemberProfile(bot as any,'-42',['2'],'@misha');assert.equal(p.status,'found');assert.equal(p.bio,'Люблю строить');assert.equal(p.photo?.data,png);assert.equal(JSON.stringify(p).includes('DO_NOT_DISCLOSE'),false);assert.equal(JSON.stringify(p).includes('"id"'),false);assert.ok(calls.filter(c=>c.method==='getChatMember').every(c=>c.body.chat_id==='-42'&&c.body.user_id===2));
});
test('unknown and duplicate names do not trigger private profile requests',async()=>{
 const calls:string[]=[];const bot={call:async(method:string,body:any)=>{calls.push(method);return method==='getChatAdministrators'?[]:member(body.user_id,'Миша','misha'+body.user_id);},downloadProfilePhoto:async()=>{throw new Error('unexpected');}};
 assert.equal((await fetchMemberProfile(bot as any,'-42',['2','3'],'Миша')).status,'ambiguous');assert.equal((await fetchMemberProfile(bot as any,'-42',['2'],'stranger')).status,'not_found');assert.ok(calls.every(m=>!['getChat','getUserProfilePhotos'].includes(m)));
});
test('privacy failures and departed members are not described as empty profiles',async()=>{
 let departed=false;const bot={call:async(method:string)=>{if(method==='getChatAdministrators')return [];if(method==='getChatMember')return {...member(),status:departed?'left':'member'};throw new BotApiError('forbidden');},downloadProfilePhoto:async()=>{throw new Error('unexpected');}};
 const p=await fetchMemberProfile(bot as any,'-42',['2'],'Миша');assert.equal(p.bio_error,'forbidden');assert.equal(p.photo_error,'forbidden');assert.equal(p.photo,null);departed=true;assert.notEqual((await fetchMemberProfile(bot as any,'-42',['2'],'Миша')).status,'found');
});
test('photo download uses only fixed Telegram origin and bounds image data',async()=>{
 const token='99:test_token';const calls:any[]=[];const bot=new BotApi(token,async(url,init)=>{calls.push({url:String(url),redirect:init?.redirect});return calls.length===1?new Response(JSON.stringify({ok:true,result:{file_path:'photos/avatar.png',file_size:68}}),{status:200}):new Response(Buffer.from(png,'base64'));});
 assert.equal((await bot.downloadProfilePhoto('photo')).mime,'image/png');assert.ok(calls.every(c=>c.url.startsWith('https://api.telegram.org/')&&c.redirect==='error'));
 for(const file_path of ['../secret','photos/../secret','https://evil.test/photo','photos/a?token=bad']){const invalid=new BotApi(token,async()=>new Response(JSON.stringify({ok:true,result:{file_path}})));await assert.rejects(invalid.downloadProfilePhoto('photo'),{code:'rejected'});}
 const tooLarge=new BotApi(token,async(url)=>String(url).includes('/getFile')?new Response(JSON.stringify({ok:true,result:{file_path:'photos/large.png'}})):new Response(Buffer.alloc(256*1024+1)));await assert.rejects(tooLarge.downloadProfilePhoto('photo'),{code:'rejected'});
});
test('profile avatar is native model image content, never base64 text or token-bearing URL',()=>{
 const result={content:[{type:'text',text:'{"bio":"original"}'},{type:'image',data:png,mimeType:'image/png'}]};const c=codexProfileToolResult(result);assert.equal(c.contentItems[0].type,'inputText');assert.equal(c.contentItems[1].type,'inputImage');assert.ok(!JSON.stringify(c.contentItems[0]).includes(png));assert.equal(profileToolContent(result)[1].type,'image');assert.throws(()=>profileToolContent({content:[{type:'image',data:png,mimeType:'image/jpeg'}]}));
});
