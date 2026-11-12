import { HOUSE_BLOCK, woodenHouseCells, type WoodenHousePhase } from './wooden-house.ts';
import type { MinecraftGoalCriterion } from '../runtime/protocol.ts';
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
 private goalEvidence?:{invocation:string;access:MinecraftAccess;observed:boolean;navigated:boolean;self?:{onGround?:boolean;hp?:number;pos?:string};origin?:{x:number;z:number}};
 private navigation?:{invocation:string;access:MinecraftAccess;target:{x:number;y:number;z:number}};
 private activeGuard?:()=>Promise<unknown>;
 private busy=false;
 private generation=0;
 private stopping=false;
 private checking=false;
 private observedSession?:string;
 private reconnectFrom?:string;
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
 async nearbySurface(radius=4){return this.readTool('getSurfaceMap',{radius});}
 async navigationStatus(){return this.readTool('pathStatus');}
 async observeGoal(invocation:string,epoch:number){
  const access=await this.options.access();
  if(access.epoch!==epoch)throw new Error('minecraft_epoch_changed');
  const scene=await this.observe();
  const current=await this.options.access();
  if(scene.connected&&scene.snapshot&&current.epoch===epoch&&current.session===access.session){
   const evidence=this.goalEvidence;
   if(evidence?.invocation===invocation&&evidence.access.session===access.session){
    evidence.observed=true;
    evidence.self=scene.snapshot.self;
   }else this.goalEvidence={invocation,access,observed:true,navigated:false,self:scene.snapshot.self};
  }
  return scene;
 }
 async recordGoalNavigation(invocation:string,epoch:number,origin?:{x:number;z:number}){
  const access=await this.options.access();
  if(access.epoch!==epoch)throw new Error('minecraft_epoch_changed');
  const evidence=this.goalEvidence;
  if(evidence?.invocation===invocation&&evidence.access.session===access.session){
   evidence.navigated=true;
   evidence.origin=origin;
  }else this.goalEvidence={invocation,access,observed:false,navigated:true,origin};
 }
 async verifiedGoalStep(invocation:string,epoch:number,criterion?:MinecraftGoalCriterion,activityId?:string):Promise<boolean>{
  const evidence=this.goalEvidence;
  if(!evidence?.observed||evidence.invocation!==invocation||evidence.access.epoch!==epoch)return false;
  try{
   const current=await this.options.access();
   if(current.epoch!==epoch||current.session!==evidence.access.session||this.goalEvidence!==evidence)return false;
   if(criterion?.kind==='grounded'){
    return !evidence.navigated&&evidence.self?.onGround===true
      &&typeof evidence.self.hp==='number'&&evidence.self.hp>=criterion.min_health;
   }
   if(criterion?.kind==='house'){
    const progress=await this.houseProgress(criterion);
    const latest=await this.options.access();
    return progress.complete&&latest.epoch===epoch&&latest.session===current.session&&this.goalEvidence===evidence;
   }
   if(criterion?.kind==='arrival'){
    const target=this.navigation?.target;
    if(evidence.navigated&&target?.x===criterion.x&&target.y===criterion.y&&target.z===criterion.z
      &&await this.verifiedArrival(invocation,epoch))return true;
    if(!activityId||evidence.self?.onGround!==true||!evidence.self.pos)return false;
    const position=evidence.self.pos.split(',').map(Number);
    if(position.length!==3||position.some(value=>!Number.isFinite(value)))return false;
    const [x,y,z]=position;
    if(Math.hypot(x-criterion.x,y-criterion.y,z-criterion.z)>=1.5)return false;
    const prior=(await this.options.pool.query(`SELECT r.result->'goal_navigation'->'origin' AS origin
      FROM runtime_turns t JOIN minecraft_tool_receipts r ON r.character_id=t.character_id
        AND r.invocation_id='activity:'||t.id::text
      WHERE t.character_id=$1 AND t.activity_id=$2 AND r.state='returned'
        AND r.result->'goal_navigation'->>'session'=$3
        AND r.result->'goal_navigation'->'target'=$4::jsonb
      ORDER BY t.created_at DESC LIMIT 1`,
      [this.options.characterId,activityId,current.session,JSON.stringify({x:criterion.x,y:criterion.y,z:criterion.z})])).rows[0];
    if(!prior?.origin||Math.hypot(x-prior.origin.x,z-prior.origin.z)<1.5)return false;
    const path=await this.navigationStatus();
    const latest=await this.options.access();
    return path?.ok===true&&path.busy===false&&latest.epoch===epoch&&latest.session===current.session&&this.goalEvidence===evidence;
   }
   return (!evidence.navigated||await this.verifiedArrival(invocation,epoch))&&this.goalEvidence===evidence;
  }catch{return false;}
 }
 private async houseBlocks(cells:{x:number;y:number;z:number}[]){
  const blocks=[];
  for(let i=0;i<cells.length;i+=6){
   blocks.push(...await Promise.all(cells.slice(i,i+6).map(cell=>this.readTool('getBlockAt',cell))));
  }
  return blocks;
 }
 async houseProgress(criterion:WoodenHousePhase){
  const {required,open}=woodenHouseCells(criterion);
  const blocks=await this.houseBlocks([...required,...open]);
  const placed=blocks.slice(0,required.length).filter(block=>block.id===HOUSE_BLOCK).length;
  const openingClear=blocks.slice(required.length).every(block=>block.is_air===true||block.is_air==='true');
  return {placed,required:required.length,opening_clear:openingClear,complete:placed===required.length&&openingClear};
 }
 async buildHouse(criterion:WoodenHousePhase,invocation:string,epoch:number,guard:()=>Promise<unknown>){
  const scene=await this.observe();
  const pos=typeof scene.snapshot?.self?.pos==='string'?scene.snapshot.self.pos.split(',').map(Number):[];
  if(!scene.connected||pos.length!==3||!pos.every(Number.isFinite)
    ||Math.hypot(pos[0]-criterion.x,pos[1]-criterion.y,pos[2]-criterion.z)>16)
   return {queued:false,reason:'house_site_out_of_range'};
  const queue=await this.readTool('buildQueue');
  if(queue.done!==true)return {queued:false,reason:'builder_busy'};
  const {place,open}=woodenHouseCells(criterion);
  const isAir=(block:any)=>block.is_air===true||block.is_air==='true';
  let unsupportedFloor=new Set<typeof place[number]>();
  if(criterion.phase==='floor'){
   const natural=(block:any)=>['minecraft:grass_block','minecraft:dirt','minecraft:stone','minecraft:coarse_dirt','minecraft:podzol'].includes(block.id);
   const ground=await this.houseBlocks(place.map(cell=>({...cell,y:cell.y-1})));
   const low=place.filter((_cell,i)=>!natural(ground[i]));
   unsupportedFloor=new Set(low);
   if(low.length===place.length||ground.some(block=>!natural(block)&&!isAir(block)&&block.id!=='minecraft:short_grass'))
    return {queued:false,reason:'house_foundation_unsupported'};
   const below=await this.houseBlocks(low.map(cell=>({...cell,y:cell.y-2})));
   if(below.some(block=>!natural(block)))return {queued:false,reason:'house_foundation_unsupported'};
  }
  const existing=await this.houseBlocks([...place,...open]);
  if(existing.slice(place.length).some(block=>!isAir(block))
    ||existing.slice(0,place.length).some(block=>!isAir(block)&&block.id!==HOUSE_BLOCK&&!(criterion.phase==='floor'&&block.id==='minecraft:short_grass')))
   return {queued:false,reason:'house_site_obstructed'};
  const pending=place.filter((_cell,i)=>existing[i].id!==HOUSE_BLOCK).sort((a,b)=>Number(unsupportedFloor.has(a))-Number(unsupportedFloor.has(b))||a.y-b.y).slice(0,20);
  if(!pending.length)return {queued:false,reason:'already_placed'};
  const inventory=await this.readTool('inventorySpace');
  if(!inventory.blocks?.[HOUSE_BLOCK])return {queued:false,reason:'oak_planks_missing'};
  return this.call('buildBlocks',{blocks:JSON.stringify(pending.map(({x,y,z})=>[x,y,z,HOUSE_BLOCK]))},
   invocation,epoch,guard,true);
 }
 async verifiedArrival(invocation:string,epoch:number):Promise<boolean>{
  const nav=this.navigation;
  if(!nav||nav.invocation!==invocation||nav.access.epoch!==epoch||this.busy||this.stopping)return false;
  try{
   const access=await this.options.access();
   if(access.epoch!==epoch||access.session!==nav.access.session)return false;
   const status=await this.navigationStatus();
   const pos=typeof status?.pos==='string'?status.pos.split(','):null;
   if(status?.ok!==true||status.busy!==false||pos?.length!==3||pos.some((v:string)=>!v.trim()||!Number.isFinite(Number(v))))return false;
   const origin=this.goalEvidence?.invocation===invocation?this.goalEvidence.origin:undefined;
   if(origin&&Math.hypot(Number(pos[0])-origin.x,Number(pos[2])-origin.z)<1.5)return false;
   const current=await this.options.access();
   return this.navigation===nav&&!this.busy&&!this.stopping&&current.epoch===epoch&&current.session===access.session
     &&Math.hypot(Number(pos[0])-nav.target.x,Number(pos[1])-nav.target.y,Number(pos[2])-nav.target.z)<1.5;
  }catch{return false;}
 }
 async observe():Promise<any>{
  const state=await this.status();
  if(!state.connected)return state;
  try{return {available:true,connected:true,stale:false,session_id:state.session_id,server_identity:'unavailable',snapshot:await this.readTool('getGameState'),observed_at:new Date().toISOString()};}
  catch{return {available:true,connected:false,stale:true,session_id:null,error_code:'unionclef_observation_failed'};}
 }
 /** Multiple independent engines share database receipts; uncertain calls are never resent. */
 async call(name:string,args:Record<string,unknown>,invocation:string,epoch:number,guard:()=>Promise<unknown>=async()=>{},retainGuard=false):Promise<unknown>{
  if(this.busy||this.stopping)throw new Error('minecraft_busy');
  const generation=this.generation;
  this.busy=true;
  try{
   const access=await this.options.access();if(access.epoch!==epoch)throw new Error('minecraft_epoch_changed');
   if(this.reconnectFrom===access.session&&name!=='ConnectToServer')throw new Error('minecraft_reconnect_pending');
   if(this.reconnectFrom!==access.session)this.reconnectFrom=undefined;
   const catalog=await this.catalog();const tool=catalog.find(t=>t.name===name);if(!tool)throw new Error('unknown_minecraft_tool');
   z.fromJSONSchema(tool.inputSchema).parse(args);
   const observesWorld=['getGameState','inventorySpace','getOpenScreen','getRecentChat','canReach','getBlockAt','getBlocksAround','getSurfaceMap',
    'pathStatus','pathingMode','punkStatus','runAwayStatus','buildQueue','mineStatus','selectionSize','undoStatus','replaceStatus','canBreakBlock','canPlaceBlock','inGame'].includes(name);
   const initiative=name==='ChatMessage'&&invocation.startsWith('initiative:');
   if(initiative){
    const recent=await this.options.pool.query(`SELECT 1 FROM minecraft_tool_receipts
      WHERE character_id=$1 AND invocation_id LIKE 'initiative:%'
        AND created_at>clock_timestamp()-interval '3 minutes' LIMIT 1`,[this.options.characterId]);
    if(recent.rowCount)return {sent:false,reason:'initiative_cooldown'};
   }
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
   if(!initiative&&!observesWorld){
    this.navigation=undefined;
    this.active=access;
    this.activeGuard=retainGuard?guard:undefined;
   }
   const result=await this.rpc('tools/call',{name,arguments:args});
   if(name==='ConnectToServer'&&!result.isError&&generation===this.generation){
    // The tool initiates a reconnect. Only a fresh authorized session can issue another call.
    this.active=undefined;
    this.activeGuard=undefined;
    this.goalEvidence=undefined;
    this.cachedStatus=undefined;
    this.reconnectFrom=access.session;
   }else{
    try{if(generation!==this.generation)throw new Error('stopped');const after=await this.options.access();if(after.epoch!==epoch||after.session!==access.session)throw new Error('revoked');}
    catch{await this.stop();throw new Error('minecraft_access_revoked');}
   }
   let receipt=result;
   if(retainGuard&&name==='gotoXYZ'&&!result.isError){
    const text=result.content?.find((item:any)=>item.type==='text')?.text;
    try{
     if(JSON.parse(text).ok===true){
      const target=args as {x:number;y:number;z:number};
      this.navigation={invocation,access,target};
      const origin=this.goalEvidence?.invocation===invocation?this.goalEvidence.origin:undefined;
      if(origin)receipt={...result,goal_navigation:{target,origin,session:access.session}};
     }
    }catch{/* No receipt of acceptance. */}
   }
   await this.options.pool.query(`UPDATE minecraft_tool_receipts SET state='returned',result=$3::jsonb WHERE character_id=$1 AND invocation_id=$2`,[this.options.characterId,invocation,JSON.stringify(receipt)]);
   return {state:'returned',result};
  }finally{this.busy=false;}
 }
 async stop():Promise<unknown>{
  this.generation++;this.stopping=true;this.navigation=undefined;this.goalEvidence=undefined;
  // These stop independent UnionClef task engines, not only the route follower.
  const results=await Promise.allSettled(['stopPathing','punkStop','runAwayStop','buildQueueClear'].map(name=>this.rpc('tools/call',{name,arguments:{}})));
  if(results.some(r=>r.status==='rejected'||r.value.isError))throw new Error('minecraft_stop_unconfirmed');
  this.active=undefined;this.activeGuard=undefined;this.stopping=false;return {stop_requested:true,completed:false};
 }
 start(){
  if(this.timer)return;
  this.timer=setInterval(()=>{void this.check();},1000);this.timer.unref();
 }
 async check(){
  if(!this.active||this.checking)return;this.checking=true;
  const active=this.active, guard=this.activeGuard;
  try{const a=await this.options.access();if(a.epoch!==active.epoch||a.session!==active.session)throw new Error('revoked');await guard?.();}
  catch{if(this.active===active)await this.stop().catch(()=>{});}
  finally{this.checking=false;}
 }
 async close(){if(this.timer)clearInterval(this.timer);if(this.active)await this.stop().catch(()=>{});}
}
