import test from 'node:test';
import assert from 'node:assert/strict';
import {approachPlayer} from '../packages/minecraft/approach-player.ts';

function fixture(){
 let now=0, distance=5, bearing=120, busy=false; const calls:string[]=[];
 const player=()=>({name:'Irlirion',uuid:'player',x:1,y:64,z:1,distance,bearing_degrees:bearing,line_of_sight:true});
 return {calls, deps:{now:()=>now,sleep:async(ms:number)=>{now+=ms;},guard:async()=>{},
  observe:async()=>({connected:true,stale:false,server:'mc.agicraft.ru:25565',session_id:'session',snapshot:{players:[player()]}}),
  pathStatus:async()=>{calls.push('path');if(busy){busy=false;distance=2;return {ok:true,busy:true};}return {ok:true,busy:false};},
  navigate:async()=>{calls.push('navigate');busy=true;return {result:{content:[{type:'text',text:'{"ok":true}'}]}};},
  stop:async()=>{calls.push('stop');},turn:async(degrees:number)=>{calls.push('turn');bearing-=degrees;return {id:'turn'};},
  turnStatus:async()=>({state:'completed',allowed:true})}};
}
test('approach waits for navigation to stop before turning and verifies bearing',async()=>{
 const f=fixture();const result=await approachPlayer('Irlirion',f.deps);
 assert.equal(result.state,'completed');assert.ok(f.calls.indexOf('turn')>f.calls.indexOf('navigate'));assert.equal(f.calls.filter(x=>x==='turn').length,2);
});
test('busy path is not interrupted or treated as arrival',async()=>{
 const f=fixture();f.deps.pathStatus=async()=>({ok:true,busy:true});const result=await approachPlayer('Irlirion',f.deps);
 assert.deepEqual(result,{state:'failed',reason:'navigation_busy'});assert.ok(!f.calls.includes('turn'));
});
test('unconfirmed turn cannot claim success',async()=>{
 const f=fixture();f.deps.turnStatus=async()=>({state:'failed',allowed:true});const result=await approachPlayer('Irlirion',f.deps);
 assert.deepEqual(result,{state:'failed',reason:'turn_unconfirmed'});
});
