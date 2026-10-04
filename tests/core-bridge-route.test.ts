import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/core/app.ts';

const TOKENS={engine:'e'.repeat(64),owner:'o'.repeat(64),audio:'a'.repeat(64),bridge:'b'.repeat(64)};
const SYSTEM_EVENT={source_key:'minecraft-system:mc.agicraft.ru:25565:irlirion:1:aa',author_id:'minecraft-system:mc.agicraft.ru:25565:irlirion',author_provenance:'minecraft_system_chat',source_server:'mc.agicraft.ru:25565',text:'привет'};
const SIGNED_EVENT={source_key:'minecraft:11111111-1111-4111-8111-111111111111:2:bb',author_id:'11111111-1111-4111-8111-111111111111',author_provenance:'fabric_profile_context',text:'привет'};

const unused=async()=>{throw new Error('unused dependency called');};
function harness(opts:{allowSystemChatPublicDemo?:boolean;audienceId?:string}={}){
  const ingested:{provenance:string;trust:string}[]=[];
  const app=buildApp({
    principal:{characterId:'sever',audienceId:opts.audienceId??'demo-public'},
    tokens:TOKENS,allowSystemChatPublicDemo:opts.allowSystemChatPublicDemo??true,
    deps:{
      pool:{query:async()=>({rows:[],rowCount:0}),end:async()=>{}},
      status:unused,search:unused,remember:unused,control:unused,nextEvent:unused,recentConversation:unused,complete:unused,deferEvent:unused,
      enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused,
      ingest:async(_p:unknown,event:{author_provenance:string;author_trust:string})=>{
        ingested.push({provenance:event.author_provenance,trust:event.author_trust});
        return {inserted:true,event_id:'11111111-2222-3333-4444-555555555555'};
      },
    }});
  const post=(path:string,body:unknown,token=TOKENS.bridge)=>app.inject({method:'POST',url:path,
    headers:{authorization:`Bearer ${token}`},payload:body as object});
  return {app,ingested,post};
}

test('a system chat event is ingested for the public demo',async()=>{
  const h=harness();
  const r=await h.post('/bridge/events',SYSTEM_EVENT);
  assert.equal(r.statusCode,200);
  assert.deepEqual(r.json(),{inserted:true,event_id:'11111111-2222-3333-4444-555555555555'});
  assert.deepEqual(h.ingested,[{provenance:'minecraft_system_chat',trust:'unverified'}]);
});
test('a system chat event is refused with 403 when the demo opt-in is off',async()=>{
  const h=harness({allowSystemChatPublicDemo:false});
  const r=await h.post('/bridge/events',SYSTEM_EVENT);
  assert.equal(r.statusCode,403);
  assert.deepEqual(h.ingested,[]);
});
test('a system chat event is refused with 403 outside the demo audience',async()=>{
  const h=harness({audienceId:'someone-private'});
  const r=await h.post('/bridge/events',SYSTEM_EVENT);
  assert.equal(r.statusCode,403);
  assert.deepEqual(h.ingested,[]);
});
test('the refusal names the scope error instead of surfacing as a server fault',async()=>{
  const r=await harness({audienceId:'someone-private'}).post('/bridge/events',SYSTEM_EVENT);
  assert.equal(r.json().error,'system_chat_public_demo_required');
});
test('signed chat is still accepted while the system chat demo opt-in is off',async()=>{
  const h=harness({allowSystemChatPublicDemo:false});
  const r=await h.post('/bridge/events',SIGNED_EVENT);
  assert.equal(r.statusCode,200);
  assert.deepEqual(h.ingested,[{provenance:'fabric_profile_context',trust:'unverified'}]);
});
test('an unknown field is rejected',async()=>{
  const r=await harness().post('/bridge/events',{...SIGNED_EVENT,author_trust:'verified'});
  assert.equal(r.statusCode,400);
});
test('a client claimed trust level is never stored, whether rejected or stripped',async()=>{
  const h=harness();
  const r=await h.post('/bridge/events',{...SIGNED_EVENT,author_trust:'verified'});
  // Rejecting the field is stricter, but the invariant is that nothing client supplied becomes trust.
  assert.ok(r.statusCode===400||r.statusCode===200);
  for(const stored of h.ingested) assert.equal(stored.trust,'unverified');
});
test('the bridge route rejects every other token',async()=>{
  const h=harness();
  for(const role of ['engine','owner','audio'] as const){
    assert.equal((await h.post('/bridge/events',SYSTEM_EVENT,TOKENS[role])).statusCode,401,role);
  }
  assert.equal((await h.post('/bridge/events',SYSTEM_EVENT,'wrong')).statusCode,401);
});
test('a browser origin is refused before any token is considered',async()=>{
  const h=harness();
  const r=await h.app.inject({method:'POST',url:'/bridge/events',
    headers:{authorization:`Bearer ${TOKENS.bridge}`,origin:'https://example.com'},payload:SYSTEM_EVENT as object});
  assert.equal(r.statusCode,403);
  assert.equal(r.json().error,'browser_access_disabled');
});
