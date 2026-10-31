import test from 'node:test';
import assert from 'node:assert/strict';
import { worldObservationSchema } from '../packages/domain/world-observation.ts';

const base={
  session_id:'11111111-1111-4111-8111-111111111111',connected:true as const,server:'mc.agicraft.ru:25565',observed_at:new Date().toISOString(),
  self:{x:0,y:66,z:0,yaw:0,pitch:0,vx:0,vy:0,vz:0,on_ground:true,health:20,dimension:'minecraft:overworld',collision_ahead:true,support_ahead:true},
  players:[],crosshair:{type:'block' as const}
};

test('world observation accepts bounded forward-obstacle diagnostics',()=>{
  const parsed=worldObservationSchema.parse({...base,self:{...base.self,step_status:'collision',obstacle_block_id:'minecraft:oak_leaves',estimated_step_up:1,nearest_support_block_id:'minecraft:stone',nearest_support_drop:2.75}});
  assert.equal(parsed.connected,true);
  if(parsed.connected)assert.equal(parsed.self.step_status,'collision');
});

test('world observation rejects invalid or oversized obstacle diagnostics',()=>{
  assert.equal(worldObservationSchema.safeParse({...base,self:{...base.self,step_status:'open'} }).success,false);
  assert.equal(worldObservationSchema.safeParse({...base,self:{...base.self,obstacle_block_id:'not-an-id'} }).success,false);
  assert.equal(worldObservationSchema.safeParse({...base,self:{...base.self,estimated_step_up:2.01} }).success,false);
  assert.equal(worldObservationSchema.safeParse({...base,self:{...base.self,nearest_support_drop:3.01} }).success,false);
});

test('visible chickens and dropped items carry entity types; hidden or oversized scenes are rejected',()=>{
 const chicken={uuid:'22222222-2222-4222-8222-222222222222',type:'minecraft:chicken',x:1,y:66,z:2,distance:2.24,bearing_degrees:27,line_of_sight:true};
 const parsed=worldObservationSchema.parse({...base,entities:[chicken],crosshair:{type:'entity',entity_type:'minecraft:chicken',distance:2.24}});
 assert.equal(parsed.connected&&parsed.entities?.[0].type,'minecraft:chicken');
 assert.equal(worldObservationSchema.safeParse({...base,entities:[{...chicken,line_of_sight:false}]}).success,false);
 assert.equal(worldObservationSchema.safeParse({...base,entities:Array(65).fill(chicken)}).success,false);
 assert.equal(worldObservationSchema.safeParse({...base,entities:[{...chicken,distance:33}]}).success,false);
});
