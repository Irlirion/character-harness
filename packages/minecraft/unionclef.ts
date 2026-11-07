import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';

const toolSchema=z.object({name:z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),description:z.string().default(''),inputSchema:z.record(z.string(),z.unknown())});
export type MinecraftTool=z.infer<typeof toolSchema>;
type WorkspaceOptions={url:string;token:string;pool:Pool;characterId:string;access:()=>Promise<MinecraftAccess>;fetch?:typeof fetch};
export type MinecraftAccess={epoch:number;session:string};
type Pool={query:(sql:string,params?:unknown[])=>Promise<{rows:any[];rowCount:number|null}>};

/** Fixed operator endpoint. Upstream descriptions and results remain tool data, never instructions. */
export class UnionClefWorkspace {
 private id=0;
 private active?:MinecraftAccess;
 private busy=false;
 private generation=0;
 private stopping=false;
 private checking=false;
 private observedSession?:string;
 private cachedStatus?:{at:number;value:any};
 private timer?:ReturnType<typeof setInterval>;
 private options:WorkspaceOptions;
 constructor(options:WorkspaceOptions){
  this.options=options;
  const u=new URL(options.url);
  if(u.protocol!=='http:'||!['127.0.0.1','localhost','host.docker.internal'].includes(u.hostname)||!u.port||u.pathname!=='/mcp'||u.username||u.password||u.search||u.hash)throw new Error('Invalid local UnionClef endpoint');
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(options.token))throw new Error('Invalid UnionClef token');
 }
 private async rpc(method:string,params:unknown):Promise<any>{
  const id=++this.id;
  const response=await (this.options.fetch??fetch)(this.options.url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${this.options.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(7000)});
  if(!response.ok||!response.body)throw new Error('unionclef_unavailable');
  const reader=response.body.getReader();let size=0;const parts:Uint8Array[]=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024)throw new Error('unionclef_response_too_large');parts.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const envelope=JSON.parse(Buffer.concat(parts).toString('utf8'));
  if(envelope.jsonrpc!=='2.0'||envelope.id!==id||envelope.error||!envelope.result)throw new Error('unionclef_rpc_failed');
  return envelope.result;
 }
 async catalog():Promise<MinecraftTool[]>{
  const initialized=await this.rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'character-harness-workspace',version:'0.3.0'}});
  if(initialized.serverInfo?.name!=='unionclef')throw new Error('unexpected_minecraft_server');
  return z.array(toolSchema).max(256).parse((await this.rpc('tools/list',{})).tools);
 }
 private async readTool(name:string,args:Record<string,unknown>={}):Promise<any>{
  const result=await this.rpc('tools/call',{name,arguments:args});
  if(result.isError)throw new Error('unionclef_observation_failed');
  const text=result.content?.find((item:any)=>item.type==='text')?.text;
  if(typeof text!=='string'||text.length>16_384)throw new Error('unionclef_observation_invalid');
  try{return JSON.parse(text);}catch{return {text:text.slice(0,4000)};}
 }
 /** Direct read-only MCP probe. UnionClef v0.95.63 does not expose server address or a reconnect/session id. */
 async status(force=false):Promise<any>{
  if(!force&&this.cachedStatus&&Date.now()-this.cachedStatus.at<4000)return this.cachedStatus.value;
  try{
   const [tools,game]=await Promise.all([this.catalog(),this.readTool('getGameState')]);
   const inGame=game?.inGame===true;
   if(!inGame)this.observedSession=undefined;
   else if(!this.observedSession)this.observedSession=randomUUID();
   const value={configured:true,connected:inGame,stale:false,state:inGame?'ready':'not_in_game',
    tool_count:tools.length,session_id:this.observedSession??null,server_identity:'unavailable',
    self:inGame&&game.self?{pos:typeof game.self.pos==='string'?game.self.pos.slice(0,100):null,dimension:typeof game.self.dimension==='string'?game.self.dimension.slice(0,80):null,hp:typeof game.self.hp==='number'?game.self.hp:null}:null,
    player_count:inGame&&Number.isSafeInteger(game.playerCount)?Math.max(0,Math.min(game.playerCount,256)):null,
    observed_at:new Date().toISOString()};
   this.cachedStatus={at:Date.now(),value};return value;
  }catch{
   this.observedSession=undefined;
   const value={configured:true,connected:false,stale:true,state:'unreachable',tool_count:null,session_id:null,server_identity:'unavailable',self:null,player_count:null,observed_at:new Date().toISOString(),error_code:'unionclef_unreachable'};
   this.cachedStatus={at:Date.now(),value};return value;
  }
 }
 async observe():Promise<any>{
  const state=await this.status();
  if(!state.connected)return state;
  try{return {available:true,connected:true,stale:false,session_id:state.session_id,server_identity:'unavailable',snapshot:await this.readTool('getGameState'),observed_at:new Date().toISOString()};}
  catch{return {available:true,connected:false,stale:true,session_id:null,error_code:'unionclef_observation_failed'};}
 }
 /** Multiple independent engines share database receipts; uncertain calls are never resent. */
 async call(name:string,args:Record<string,unknown>,invocation:string,epoch:number,guard:()=>Promise<unknown>=async()=>{}):Promise<unknown>{
  if(this.busy||this.stopping)throw new Error('minecraft_busy');
  const generation=this.generation;
  this.busy=true;
  try{
   const access=await this.options.access();if(access.epoch!==epoch)throw new Error('minecraft_epoch_changed');
   const catalog=await this.catalog();const tool=catalog.find(t=>t.name===name);if(!tool)throw new Error('unknown_minecraft_tool');
   z.fromJSONSchema(tool.inputSchema).parse(args);
   if(name==='ConnectToServer')throw new Error('server_switch_requires_reconnect');
   if(name==='ExecuteCommand')throw new Error('arbitrary_commands_disabled');
   if(name==='ChatMessage'&&typeof args.msg==='string'&&/^[\s]*[;@/]/.test(args.msg))throw new Error('minecraft_commands_disabled');
   const payload=JSON.stringify({name,args,epoch,session:access.session});
   const hash=createHash('sha256').update(payload).digest('hex');
   const inserted=await this.options.pool.query(`INSERT INTO minecraft_tool_receipts(character_id,invocation_id,request_hash,state) VALUES($1,$2,$3,'unknown') ON CONFLICT DO NOTHING RETURNING invocation_id`,[this.options.characterId,invocation,hash]);
   if(!inserted.rowCount){
    const prior=(await this.options.pool.query('SELECT request_hash,state,result FROM minecraft_tool_receipts WHERE character_id=$1 AND invocation_id=$2',[this.options.characterId,invocation])).rows[0];
    if(!prior||prior.request_hash!==hash)throw new Error('minecraft_invocation_conflict');
    return {state:prior.state,result:prior.result,replayed:true};
   }
   await guard();
   if(generation!==this.generation)throw new Error('minecraft_stopped');
   const current=await this.options.access();if(current.epoch!==epoch||current.session!==access.session)throw new Error('minecraft_session_changed');
   this.active=access;
   const result=await this.rpc('tools/call',{name,arguments:args});
   try{if(generation!==this.generation)throw new Error('stopped');const after=await this.options.access();if(after.epoch!==epoch||after.session!==access.session)throw new Error('revoked');}
   catch{await this.stop();throw new Error('minecraft_access_revoked');}
   await this.options.pool.query(`UPDATE minecraft_tool_receipts SET state='returned',result=$3::jsonb WHERE character_id=$1 AND invocation_id=$2`,[this.options.characterId,invocation,JSON.stringify(result)]);
   return {state:'returned',result};
  }finally{this.busy=false;}
 }
 async stop():Promise<unknown>{
  this.generation++;this.stopping=true;
  // These stop independent UnionClef task engines, not only the route follower.
  const results=await Promise.allSettled(['stopPathing','punkStop','runAwayStop','buildQueueClear'].map(name=>this.rpc('tools/call',{name,arguments:{}})));
  if(results.some(r=>r.status==='rejected'||r.value.isError))throw new Error('minecraft_stop_unconfirmed');
  this.active=undefined;this.stopping=false;return {stop_requested:true,completed:false};
 }
 start(){
  if(this.timer)return;
  this.timer=setInterval(()=>{void this.check();},1000);this.timer.unref();
 }
 async check(){
  if(!this.active||this.checking)return;this.checking=true;
  try{const a=await this.options.access();if(a.epoch!==this.active.epoch||a.session!==this.active.session)throw new Error('revoked');}
  catch{await this.stop().catch(()=>{});}
  finally{this.checking=false;}
 }
 async close(){if(this.timer)clearInterval(this.timer);if(this.active)await this.stop().catch(()=>{});}
}
