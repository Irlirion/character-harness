import { z } from 'zod';

const cell = z.object({
 dx:z.coerce.number().int().min(-6).max(6),
 dz:z.coerce.number().int().min(-6).max(6),
 top_dy:z.coerce.number().int().min(-384).max(384),
 block:z.string().min(1).max(100),
});

/** Preserve the block and elevation of each observed cell without repeating its coordinates and keys. */
export function compactRuntimeSurface(value:unknown) {
 const cells=z.array(z.unknown()).min(1).max(169).parse(value);
 const legend:string[]=[];
 const radius=cells.length>81?6:4;
 const diameter=2*radius+1;
 const rows=Array.from({length:diameter},()=>Array<string>(diameter).fill('?'));
 for(const entry of cells){
  const parsed=cell.safeParse(entry);
  if(!parsed.success)continue;
  const {dx,dz,top_dy,block}=parsed.data;
  let id=legend.indexOf(block);
  if(id<0){id=legend.length;legend.push(block);}
  if(Math.abs(dx)>radius||Math.abs(dz)>radius)continue;
  rows[dz+radius][dx+radius]=`${id}:${top_dy}`;
 }
 return {origin:[-radius,-radius],axes:'rows dz, columns dx; cell block-id:top_dy relative to feet; ? unknown',legend,
  rows:rows.map(row=>row.join(' '))};
}

/** Candidate feet positions above known full blocks in the current surface survey. */
export function minecraftArrivalCandidates(value:unknown,position:number[]){
 const [x,y,z]=position;
 const targets:{x:number;y:number;z:number}[]=[];
 if(!Array.isArray(value))return targets;
 for(const entry of value){
  const parsed=cell.safeParse(entry);
  if(!parsed.success)continue;
  const {dx,dz,top_dy,block}=parsed.data;
  if(!['grass block','dirt','stone','sand','gravel','podzol','coarse dirt'].includes(block))continue;
  const target={x:Math.floor(x)+dx,y:Math.floor(y)+top_dy+1,z:Math.floor(z)+dz};
  const distance=Math.hypot(target.x-x,target.z-z);
  if(distance>=3&&distance<=5.5&&Math.abs(target.y-y)<=1)targets.push(target);
 }
 return targets.sort((a,b)=>Math.abs(a.y-y)-Math.abs(b.y-y)||Math.hypot(a.x-x,a.z-z)-Math.hypot(b.x-x,b.z-z)).slice(0,8);
}

/** Find 7×5 footprints supported by natural terrain with at most one block of relief. */
export function minecraftHouseSites(value:unknown,position:number[]){
 if(!Array.isArray(value))return [];
 const [x,y,z]=position;
 const heights=new Map<string,number>();
 for(const entry of value){
  const parsed=cell.safeParse(entry);
  if(!parsed.success)continue;
  const {dx,dz,top_dy,block}=parsed.data;
  if(['grass block','dirt','stone','coarse dirt','podzol'].includes(block))heights.set(`${dx},${dz}`,top_dy);
  else if(block==='short grass')heights.set(`${dx},${dz}`,top_dy-1);
 }
 const sites=[];
 for(let dx=-6;dx<=0;dx++)for(let dz=-6;dz<=2;dz++){
  const footprint=Array.from({length:35},(_,i)=>heights.get(`${dx+i%7},${dz+Math.floor(i/7)}`));
  if(!footprint.every(height=>height!==undefined))continue;
  const height=Math.max(...footprint);
  if(height-Math.min(...footprint)>1||Math.abs(height+1)>1)continue;
  const origin={x:Math.floor(x)+dx,y:Math.floor(y)+height+1,z:Math.floor(z)+dz};
  if(x>=origin.x&&x<origin.x+7&&z>=origin.z&&z<origin.z+5)continue;
  sites.push(origin);
 }
 return sites.sort((a,b)=>Math.hypot(a.x+3-x,a.z+2-z)-Math.hypot(b.x+3-x,b.z+2-z)).slice(0,8);
}
