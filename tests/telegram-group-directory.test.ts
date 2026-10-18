import test from 'node:test';import assert from 'node:assert/strict';import {fetchGroupDirectory} from '../packages/telegram/group-directory.ts';import {groupDirectoryServer} from '../packages/telegram/directory-server.ts';import {BotApiError} from '../packages/telegram/api.ts';
const user=(id:number,name:string,status='member')=>({status,user:{id,first_name:name,username:'name'+id}});
test('directory reads counts/admins and only observed users without returning numeric IDs',async()=>{
 const calls:any[]=[];const bot={call:async(method:string,body:any)=>{calls.push({method,body});return method==='getChatMemberCount'?4:method==='getChatAdministrators'?[user(1,'Admin','administrator')]:body.user_id===2?user(2,'Misha'):user(3,'Departed','left');}};
 const d=await fetchGroupDirectory(bot as any,'-42',['2','3','2','invalid']);assert.equal(d.member_count,4);assert.equal(d.known_members.length,1);assert.equal(d.known_members[0].display_name,'Misha');assert.equal(calls.length,4);assert.equal(JSON.stringify(d).includes('"id"'),false);assert.ok(calls.every(c=>c.body.chat_id==='-42'));
});
test('partial permissions and Telegram failures retain available evidence',async()=>{
 const d=await fetchGroupDirectory({call:async(method:string)=>{if(method==='getChatMemberCount')return 7;throw new BotApiError('forbidden');}} as any,'-42',['1']);assert.equal(d.member_count,7);assert.equal(d.administrators_error,'forbidden');assert.equal(d.member_lookup_errors,1);assert.deepEqual(d.known_members,[]);
});
test('internal endpoint requires worker credential, rejects arbitrary shape and returns no-store data',async()=>{
 let calls=0;const server=groupDirectoryServer({call:async(method:string)=>{calls++;return method==='getChatMemberCount'?3:[];}} as any,'t'.repeat(64));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));try{
 const address=server.address() as {port:number};const url='http://127.0.0.1:'+address.port+'/group-participants';
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);assert.equal(calls,0);
 const headers={Authorization:'Bearer '+'t'.repeat(64),'Content-Type':'application/json'};
 assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({chat_id:'-42',known_user_ids:[],url:'https://example.com'})})).status,400);assert.equal(calls,0);
 const r=await fetch(url,{method:'POST',headers,body:JSON.stringify({chat_id:'-42',known_user_ids:[]})});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal((await r.json()).member_count,3);assert.equal(calls,2);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
