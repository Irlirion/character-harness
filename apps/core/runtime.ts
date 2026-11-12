import { createHash } from 'node:crypto';
import { worldObservationSchema } from '../../packages/domain/world-observation.ts';
import { secretDetected } from '../../packages/runtime/policy.ts';
import type { latestWorldObservation } from '../../packages/storage/observations.ts';
import type { UnionClefWorkspace } from '../../packages/minecraft/unionclef.ts';
import type { RuntimeExecutionGate } from '../../packages/runtime/gate.ts';
import { StartWorkSchema, UsageSchema, NextWorkSchema } from '../../packages/runtime/protocol.ts';
import { WorkLeaseSchema } from '../../packages/runtime/protocol.ts';
import { DomainError } from '../../packages/domain/policy.ts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Principal } from '../../packages/domain/policy.ts';
import type { RuntimeStore } from '../../packages/storage/runtime.ts';
import { ActivityPageSchema, CancelActivitySchema, CreateActivitySchema, ActivityInputSchema, ClaimWorkSchema, WorkDecisionSchema } from '../../packages/runtime/contracts.ts';

export type RuntimeOwnerStore = Pick<RuntimeStore, 'assign' | 'list' | 'inspect' | 'cancel' | 'provideInput'>;

/** Uses the app's owner-token auth and shared owner rate budget; no engine routes. */
export function runtimeOwnerRoutes(app: FastifyInstance, principal: Principal, store: RuntimeOwnerStore) {
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/owner/activities')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.post('/owner/activities', async req => store.assign(principal, CreateActivitySchema.parse(req.body)));
  app.get('/owner/activities', async req => {
    const {limit,offset} = ActivityPageSchema.parse(req.query);
    return { activities: await store.list(principal,limit,offset) };
  });
  app.get('/owner/activities/:id', async req => store.inspect(principal,z.uuid().parse((req.params as {id:string}).id)));
  app.post('/owner/activities/:id/input', async req => store.provideInput(principal,z.uuid().parse((req.params as {id:string}).id),ActivityInputSchema.parse(req.body)));
  app.post('/owner/activities/:id/cancel', async req => {
    const id = z.uuid().parse((req.params as {id:string}).id);
    const {expected_version} = CancelActivitySchema.parse(req.body);
    return store.cancel(principal,id,expected_version);
  });
}

export type RuntimeEngineStore = Pick<RuntimeStore,'claim'|'decide'|'lease'|'assertLegacyTurn'>;
export type RuntimePlanningPolicy = RuntimeExecutionGate;

export function runtimeEngineRoutes(app:FastifyInstance,principal:Principal,policy?:RuntimePlanningPolicy,minecraft?:UnionClefWorkspace,worldObservation?:typeof latestWorldObservation) {
  app.addHook('onSend',async(req,reply,payload)=>{
    if(['/engine/next_work','/engine/work_lease','/engine/work_decision','/engine/work_start','/engine/work_usage'].includes(req.routeOptions.url??'')||req.url.startsWith('/owner/runtime-'))reply.header('Cache-Control','no-store');
    return payload;
  });
  if(policy?.overview)app.get('/owner/runtime-policy',{preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'owner'}}},async()=>policy.overview!(principal));
  if(policy?.reviewQueue)app.get('/owner/runtime-reviews',{preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'owner'}}},async()=>({reviews:await policy.reviewQueue!(principal)}));
  if(policy?.retryReview)app.post('/owner/runtime-reviews/retry',{preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'owner'}}},async req=>policy.retryReview!(principal,req.body));
  app.post('/engine/next_work',async req=>{
    const body=ClaimWorkSchema.parse(req.body);
    if(!policy)return {work:null,reason:'runtime_policy_blocked'};
    return NextWorkSchema.parse(await policy.claim(principal,body));
  });
  app.post('/engine/work_lease',async req=>{
    const body=WorkLeaseSchema.parse(req.body);
    if(!policy)return {valid:false};
    return policy.lease(principal,body);
  });
  if(minecraft&&policy?.gameLease){
    const authorize=async(lease:unknown,navigate=false,initiative=false)=>{
      if(!(await policy.gameLease!(principal,lease,navigate,initiative)).valid)throw new DomainError('runtime_game_lease_invalid');
    };
    const nearbyPlayers=async()=>{
      const world=await worldObservation?.(principal);
      if(!world?.connected||world.stale)return 0;
      const snapshot=worldObservationSchema.safeParse(world.snapshot);
      return snapshot.success&&snapshot.data.connected
        ? snapshot.data.players.filter(player=>player.line_of_sight&&player.distance<=12).length
        : 0;
    };
    app.post('/engine/work_minecraft',{preHandler:app.rateLimit(),config:{rateLimit:{max:300,timeWindow:'1 minute',keyGenerator:()=> 'engine'}}},async req=>{
      const body=z.object({
        lease:WorkLeaseSchema,
        action:z.enum(['observe','surface','house_surface','navigate','path_status','speak','build','build_status','catalog','call']),
        name:z.string().min(1).max(100).optional(),
        arguments:z.record(z.string(),z.unknown()).optional(),
        call_id:z.string().min(1).max(200).optional(),
        text:z.string().trim().min(1).max(160).optional(),
        target:z.object({x:z.number().int(),y:z.number().int(),z:z.number().int()}).strict().optional()
      }).strict().parse(req.body);
      await authorize(body.lease,body.action==='navigate',body.action==='speak');
      const invocation=`activity:${body.lease.turn_id}`;
      if(body.action==='catalog')return minecraft.catalog();
      if(body.action==='call'){
        if(!body.name||!body.call_id)throw new DomainError('runtime_game_call_required');
        const callKey=createHash('sha256').update(body.call_id).digest('hex');
        return minecraft.call(body.name,body.arguments??{},`activity-tool:${body.lease.turn_id}:${callKey}`,
          body.lease.epoch,()=>authorize(body.lease),true);
      }
      if(body.action==='observe'){
        const scene=await minecraft.observeGoal(invocation,body.lease.epoch);
        const [nearby_players,criterion_met]=await Promise.all([nearbyPlayers(),policy.gameCriterionMet?.(principal,body.lease)]);
        return {...scene,nearby_players,criterion_met};
      }
      if(body.action==='speak'){
        if(!body.text||/[\x00-\x1f\x7f\u2028\u2029]/.test(body.text)||/^[;@/]/.test(body.text)||secretDetected(body.text))
          throw new DomainError('minecraft_initiative_text_invalid');
        if(!await nearbyPlayers())return {sent:false,reason:'no_nearby_players'};
        return minecraft.call('ChatMessage',{msg:body.text},`initiative:${body.lease.turn_id}`,body.lease.epoch,async()=>{
          await authorize(body.lease,false,true);
          if(!await nearbyPlayers())throw new DomainError('minecraft_initiative_no_players');
        });
      }
      if(body.action==='surface'||body.action==='house_surface')return minecraft.nearbySurface(body.action==='house_surface'?6:4);
      if(body.action==='build'||body.action==='build_status'){
        const criterion=await policy.gameHousePhase?.(principal,body.lease);
        if(!criterion)throw new DomainError('minecraft_house_phase_required');
        if(body.action==='build_status')return minecraft.houseProgress(criterion);
        return minecraft.buildHouse(criterion,`house:${body.lease.turn_id}`,body.lease.epoch,()=>authorize(body.lease));
      }
      if(body.action==='path_status'){
        const status=await minecraft.navigationStatus();
        return {status,verified_arrival:await minecraft.verifiedArrival(`activity:${body.lease.turn_id}`,body.lease.epoch)};
      }
      if(!body.target)throw new DomainError('runtime_game_target_required');
      const scene=await minecraft.observe();
      const match=typeof scene.snapshot?.self?.pos==='string'
        ? /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(scene.snapshot.self.pos)
        : null;
      const origin=scene.connected&&match?{x:Number(match[1]),y:Number(match[2]),z:Number(match[3])}:undefined;
      await minecraft.recordGoalNavigation(invocation,body.lease.epoch,origin);
      if(!origin)throw new DomainError('runtime_game_position_unknown');
      const horizontalDistance=Math.hypot(body.target.x-origin.x,body.target.z-origin.z);
      if(horizontalDistance<3)return {target_too_close:true,origin,minimum_horizontal_distance:3};
      if(Math.hypot(horizontalDistance,body.target.y-origin.y)>24)throw new DomainError('runtime_game_target_too_far');
      return minecraft.call('gotoXYZ',body.target,invocation,body.lease.epoch,()=>authorize(body.lease,true),true);
    });
  }
  app.post('/engine/work_start',async req=>{
    const body=StartWorkSchema.parse(req.body);
    if(!policy)throw new DomainError('runtime_policy_blocked');
    return policy.start(principal,body);
  });
  app.post('/engine/work_usage',async req=>{
    const body=UsageSchema.parse(req.body);
    if(!policy)throw new DomainError('runtime_policy_blocked');
    return policy.usage(principal,body);
  });
  app.post('/engine/work_decision',async req=>{
    const body=WorkDecisionSchema.parse(req.body);
    if(!policy)throw new DomainError('runtime_policy_blocked');
    return policy.decide(principal,body);
  });
}
