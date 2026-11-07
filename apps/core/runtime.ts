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

export function runtimeEngineRoutes(app:FastifyInstance,principal:Principal,policy?:RuntimePlanningPolicy) {
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
