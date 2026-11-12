type Player={name:string;uuid:string;x:number;y:number;z:number;distance:number;bearing_degrees:number;line_of_sight:boolean};
type Observation={connected?:boolean;stale?:boolean;server?:string;session_id?:string;snapshot?:{players:Player[]}};
type Deps={observe:()=>Promise<Observation>;pathStatus:()=>Promise<any>;navigate:(p:Player)=>Promise<any>;stop:()=>Promise<unknown>;turn:(degrees:number,index:number)=>Promise<{id:string}>;turnStatus:(id:string)=>Promise<any>;guard:()=>Promise<unknown>;sleep:(ms:number)=>Promise<void>;now:()=>number};

/** Approach a currently visible player, wait for pathing to stop, then face and verify. */
export async function approachPlayer(name:string,d:Deps){
 const start=d.now(),deadline=start+30000; let navigationStarted=false; let session:string|undefined; let uuid:string|undefined;
 const observe=async()=>{
  await d.guard();const o=await d.observe();
  if(!o.connected||o.stale||o.server!=='mc.agicraft.ru:25565'||!o.session_id)throw new Error('observation_unavailable');
  if(session&&session!==o.session_id)throw new Error('session_changed');session=o.session_id;
  const matches=(o.snapshot?.players??[]).filter(p=>p.line_of_sight&&p.name.toLowerCase()===name.toLowerCase()&&(!uuid||uuid===p.uuid));
  if(matches.length!==1)throw new Error('player_not_visible');uuid=matches[0].uuid;return matches[0];
 };
 try{
  let player=await observe();
  let path=await d.pathStatus();
  if(path?.ok!==true||typeof path.busy!=='boolean')throw new Error('path_status_unavailable');
  if(path.busy)throw new Error('navigation_busy');
  if(player.distance>2.5){
   const result=await d.navigate(player);const raw=result?.result?.content?.find((x:any)=>x.type==='text')?.text;
   let accepted=false;try{accepted=!result?.result?.isError&&JSON.parse(raw).ok===true;}catch{}
   if(!accepted)throw new Error('navigation_not_accepted');navigationStarted=true;
   do {if(d.now()>=deadline)throw new Error('navigation_timeout');await d.sleep(500);await d.guard();path=await d.pathStatus();if(path?.ok!==true||typeof path.busy!=='boolean')throw new Error('path_status_unavailable');} while(path.busy);
   navigationStarted=false;
   player=await observe();if(player.distance>2.5)throw new Error('player_not_reached');
  }
  for(let i=0;i<3;i++){
   // Pathfinder may change the camera until it has actually stopped.
   path=await d.pathStatus();if(path?.ok!==true||path.busy!==false)throw new Error('navigation_not_stopped');
   player=await observe();if(player.distance>2.5)throw new Error('player_moved');
   if(Math.abs(player.bearing_degrees)<=10)return {state:'completed',distance:player.distance,bearing_degrees:player.bearing_degrees};
   const action=await d.turn(Math.max(-90,Math.min(90,player.bearing_degrees)),i);
   let status:any;
   do{if(d.now()>=deadline)throw new Error('turn_timeout');await d.sleep(200);await d.guard();status=await d.turnStatus(action.id);}while(status.state==='pending'||status.state==='claimed');
   if(status.state!=='completed'||status.allowed!==true)throw new Error('turn_unconfirmed');
   await d.sleep(1100); // Wait for a fresh observation, not the pre-turn snapshot.
  }
  player=await observe();if(player.distance<=2.5&&Math.abs(player.bearing_degrees)<=10)return {state:'completed',distance:player.distance,bearing_degrees:player.bearing_degrees};
  throw new Error('facing_unconfirmed');
 }catch(e){if(navigationStarted)await d.stop().catch(()=>{});return {state:'failed',reason:e instanceof Error?e.message:'unknown'};}
}
