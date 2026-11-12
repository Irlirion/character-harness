import type { MinecraftGoalCriterion } from '../runtime/protocol.ts';

export type WoodenHousePhase=Extract<MinecraftGoalCriterion,{kind:'house'}>;
export const HOUSE_BLOCK='minecraft:oak_planks';
export function woodenHouseCells({x,y,z,phase,size}:WoodenHousePhase){
 type Cell={x:number;y:number;z:number};
 const floor:Cell[]=[],walls:Cell[]=[],roof:Cell[]=[],open:Cell[]=[];
 const [width,depth,height]=size==='7x5'?[7,5,3]:[3,3,2];
 for(let dx=0;dx<width;dx++)for(let dz=0;dz<depth;dz++){
  floor.push({x:x+dx,y,z:z+dz});
  roof.push({x:x+dx,y:y+height+1,z:z+dz});
  const perimeter=dx===0||dx===width-1||dz===0||dz===depth-1;
  for(let dy=1;dy<=height;dy++){
   const doorway=dx===Math.floor(width/2)&&dz===depth-1&&dy<=2;
   const window=size==='7x5'&&dy===2&&(
    (dx===0||dx===width-1)&&dz===2 || (dz===0||dz===depth-1)&&dx===2
   );
   (perimeter&&!doorway&&!window?walls:open).push({x:x+dx,y:y+dy,z:z+dz});
  }
 }
 return {place:{floor,walls,roof}[phase],required:phase==='roof'?[...floor,...walls,...roof]:phase==='walls'?[...floor,...walls]:floor,open};
}
