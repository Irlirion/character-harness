import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {UnionClefWorkspace} from '../packages/minecraft/unionclef.ts';

function fixture(){
 const receipts=new Map<string,any>();const calls:any[]=[];let unavailable=false;let access={epoch:7,session:'world-one'};let broken=false;
 const pool={query:async(sql:string,p:any[]=[])=>{
  const key=p[0]+':'+p[1];
  if(sql.startsWith('INSERT')){if(receipts.has(key))return {rowCount:0,rows:[]};receipts.set(key,{request_hash:p[2],state:'unknown',result:null});return {rowCount:1,rows:[{}]};}
  if(sql.startsWith('UPDATE')){Object.assign(receipts.get(key),{state:'returned',result:JSON.parse(p[2])});return {rowCount:1,rows:[]};}
  return {rowCount:1,rows:[receipts.get(key)]};
 }};
 const catalog=[{name:'ExecuteCommand',description:'Game command',inputSchema:{type:'object',properties:{cmd:{type:'string'}},required:['cmd']}},{name:'pathStatus',inputSchema:{type:'object',properties:{}}}];
 const fakeFetch:typeof fetch=async(_url,init)=>{
  assert.equal((init!.headers as any).Authorization,'Bearer '+'a'.repeat(40));assert.equal(init!.redirect,'error');
  const req=JSON.parse(String(init!.body));calls.push(req);
  if(broken&&req.method==='tools/call'&&req.params.name==='ExecuteCommand')throw new Error('network lost after dispatch');
  const result=req.method==='initialize'?{serverInfo:{name:'unionclef'}}:req.method==='tools/list'?{tools:catalog}:{content:[{type:'text',text:JSON.stringify(req.params.name==='pathStatus'?{busy:false,arrived:true}:{ok:true})}],isError:false};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result}),{headers:{'Content-Type':'application/json'}});
 };
 const create=(override?:typeof pool)=>new UnionClefWorkspace({url:'http://127.0.0.1:25350/mcp',token:'a'.repeat(40),pool:override??pool,characterId:'lada',fetch:fakeFetch,access:async()=>{if(unavailable)throw new Error('paused');return access;}});
 return {create,calls,receipts,unavailable:()=>unavailable=true,break:()=>broken=true,changeSession:()=>access={...access,session:'world-two'}};
}

test('complete catalog can execute game commands and preserve raw non-ok perception results',async()=>{
 const f=fixture(),w=f.create();assert.equal((await w.catalog()).length,2);
 const sent:any=await w.call('ExecuteCommand',{cmd:'@get log 3'},'event:call',7);
 assert.equal(sent.state,'returned');assert.equal(JSON.parse(sent.result.content[0].text).ok,true);
 const observation:any=await w.call('pathStatus',{},'event:read',7);
 assert.equal(JSON.parse(observation.result.content[0].text).arrived,true);
});

test('receipts prevent duplicate mutation across workspace instances and reject altered arguments',async()=>{
 const f=fixture();await f.create().call('ExecuteCommand',{cmd:'@get log 3'},'same',7);
 const replay:any=await f.create().call('ExecuteCommand',{cmd:'@get log 3'},'same',7);
 assert.equal(replay.replayed,true);
 assert.equal(f.calls.filter(c=>c.method==='tools/call').length,1);
 await assert.rejects(f.create().call('ExecuteCommand',{cmd:'@get log 4'},'same',7),/invocation_conflict/);
});

test('uncertain network outcome stays unknown and is not resent',async()=>{
 const f=fixture();f.break();await assert.rejects(f.create().call('ExecuteCommand',{cmd:'@get log 3'},'same',7));
 const replay:any=await f.create().call('ExecuteCommand',{cmd:'@get log 3'},'same',7);
 assert.equal(replay.state,'unknown');assert.equal(replay.replayed,true);
 assert.equal(f.calls.filter(c=>c.method==='tools/call').length,1);
});

test('schema, server catalog, epoch and pause are checked before dispatch',async()=>{
 const f=fixture(),w=f.create();
 await assert.rejects(w.call('ExecuteCommand',{cmd:42},'bad-schema',7));
 await assert.rejects(w.call('notATool',{},'unknown',7),/unknown_minecraft_tool/);
 await assert.rejects(w.call('ExecuteCommand',{cmd:'@stop'},'old',6),/epoch_changed/);
 f.unavailable();await assert.rejects(w.call('ExecuteCommand',{cmd:'@stop'},'paused',7));
 assert.equal(f.calls.filter(c=>c.method==='tools/call').length,0);
});

test('pause or replaced world stops all independent task engines',async()=>{
 for(const revoke of ['unavailable','changeSession'] as const){
  const f=fixture(),w=f.create();await w.call('ExecuteCommand',{cmd:'@get log 3'},'same',7);f[revoke]();await w.check();
  assert.deepEqual(f.calls.filter(c=>c.method==='tools/call').map(c=>c.params.name),['ExecuteCommand','stopPathing','punkStop','runAwayStop','buildQueueClear']);
 }
});

test('remote endpoints and embedded credentials cannot receive the MCP token',()=>{
 for(const url of ['http://evil.example:25350/mcp','http://token@localhost:25350/mcp','https://localhost:25350/mcp','http://localhost:25350/mcp?x=1']){
  assert.throws(()=>new UnionClefWorkspace({url,token:'a'.repeat(40),characterId:'lada',pool:{query:async()=>({rows:[],rowCount:0})},access:async()=>({epoch:1,session:'s'})}));
 }
});


test('PostgreSQL receipts fence concurrent dispatch across independent engines',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});const schema='mc_workspace_'+randomUUID().replaceAll('-','');let db:pg.Pool|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);db=new pg.Pool({connectionString:url.toString()});
  for(const name of ['001-core','021-minecraft-workspace'])await db.query(await readFile(new URL('../migrations/'+name+'.sql',import.meta.url),'utf8'));
  await db.query("INSERT INTO characters(id,name,persona) VALUES('lada','Lada','Persona')");
  const f=fixture();const [a,b]=await Promise.all([f.create(db).call('ExecuteCommand',{cmd:'@get log 3'},'same',7),f.create(db).call('ExecuteCommand',{cmd:'@get log 3'},'same',7)]) as any[];
  assert.equal(f.calls.filter(c=>c.method==='tools/call').length,1);assert.ok(a.replayed||b.replayed);
  const row=(await db.query('SELECT state FROM minecraft_tool_receipts')).rows[0];assert.equal(row.state,'returned');
 }finally{await db?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});


test('a stop during catalog discovery fences dispatch even if permissions remain valid',async()=>{
 const f=fixture(),w=f.create();let release:()=>void=()=>{};let entered:()=>void=()=>{};
 const waiting=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const call=w.call('ExecuteCommand',{cmd:'@get log 3'},'stop-race',7,async()=>{entered();await waiting;});
 await ready;await w.stop();release();await assert.rejects(call,/minecraft_stopped/);
 assert.equal(f.calls.filter(c=>c.method==='tools/call'&&c.params.name==='ExecuteCommand').length,0);
});
