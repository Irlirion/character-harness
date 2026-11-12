import { z } from 'zod';
import type { Principal } from '../domain/policy.ts';
import { DomainError } from '../domain/policy.ts';
import type { RuntimeStore } from '../storage/runtime.ts';
import { RuntimeAuthorizationStore, profileUsable } from '../storage/runtime-authorization.ts';
import { ClaimWorkSchema, WorkDecisionSchema } from './contracts.ts';
import { RuntimeWorkSchema, readMinecraftGoal, canonicalNavigationGoal, validMinecraftGoalDecision, VERIFIED_GOAL_SUMMARY, VERIFIED_NAVIGATION_SUMMARY, WorkLeaseSchema, StartWorkSchema, UsageSchema, type RuntimeWork, type PlanningInput, type MinecraftGoalCriterion } from './protocol.ts';
import { fingerprint, decisionPayload, sourceFingerprint, requestPayload, reviewContent, type ContentReviewer } from './policy.ts';

export interface RuntimeExecutionGate {
 claim(p:Principal,input:unknown):Promise<{work:RuntimeWork|null;reason?:string}>;
 lease(p:Principal,input:unknown):Promise<{valid:boolean}>;
 start(p:Principal,input:unknown):Promise<{allowed:boolean}>;
 decide(p:Principal,input:unknown):Promise<unknown>;
 usage(p:Principal,input:unknown):Promise<unknown>;
 gameHousePhase?(p:Principal,input:unknown):Promise<Extract<MinecraftGoalCriterion,{kind:'house'}>|null>;
 gameCriterionMet?(p:Principal,input:unknown):Promise<boolean>;
 overview?(p:Principal):Promise<unknown>;
 executionEnabled?(p:Principal):Promise<boolean>;
 gameLease?(p:Principal,input:unknown,navigate?:boolean,initiative?:boolean):Promise<{valid:boolean}>;
 reviewQueue?(p:Principal):Promise<unknown>;
 retryReview?(p:Principal,input:unknown):Promise<unknown>;
}

/** Default-deny orchestrator. Reviewer and operator profile are explicit trusted dependencies. */
export class RuntimePolicyGate implements RuntimeExecutionGate {
 private runtime:RuntimeStore;private auth:RuntimeAuthorizationStore;private reviewer?:ContentReviewer;private timeoutMs:number;private verifiedArrival?: (turnId:string,epoch:number)=>Promise<boolean>;private verifiedGoalStep?: (turnId:string,epoch:number,criterion?:MinecraftGoalCriterion,activityId?:string)=>Promise<boolean>;
 private readonly skipMinecraftContentReview:boolean;
 constructor(runtime:RuntimeStore,auth:RuntimeAuthorizationStore,reviewer?:ContentReviewer,timeoutMs=2000,verifiedArrival?:(turnId:string,epoch:number)=>Promise<boolean>,verifiedGoalStep?:(turnId:string,epoch:number,criterion?:MinecraftGoalCriterion,activityId?:string)=>Promise<boolean>,skipMinecraftContentReview=false){this.runtime=runtime;this.auth=auth;this.reviewer=reviewer;this.timeoutMs=timeoutMs;this.verifiedArrival=verifiedArrival;this.verifiedGoalStep=verifiedGoalStep;this.skipMinecraftContentReview=skipMinecraftContentReview;}
 private gameContentReviewer():ContentReviewer|undefined {
  return this.skipMinecraftContentReview
   ? async request=>({verdict:'allow',rule_id:'minecraft_content_review_disabled',policy_version:request.policy_version,payload_hash:request.payload_hash})
   : this.reviewer;
 }
 async claim(p:Principal,input:unknown) {
  const b=ClaimWorkSchema.parse(input);const current=await this.auth.profile(p);
  if(!current||!profileUsable(current.profile,Date.now()))return {work:null,reason:'runtime_policy_blocked'};
  const profile=current.profile;
  if(b.engine!==profile.engine||b.model!==profile.model)return {work:null,reason:'runtime_model_mismatch'};
  await this.runtime.reconcile(p);
  // Replays return the original reviewed context, not a freshly assembled prompt.
  const old=await this.auth.replay(p,b.request_id);
  if(old){
   if(!await this.auth.grantValid(p,old.turn_id))return {work:null,reason:'claim_expired'};
   return this.wrap(p,await this.runtime.claim(p,b));
  }
  const candidate=await this.runtime.preview(p,profile.version);
  if(!candidate)return {work:null,reason:'idle_or_budget_blocked'};
  const a=candidate.activity;
  const minecraftGoal=a.origin==='self'&&a.invocation_id.startsWith('minecraft-self:goal:');
  const plan=minecraftGoal?readMinecraftGoal(candidate.checkpoint):null;
  if(!minecraftGoal&&!(await this.auth.budget(p,profile)).allowed)return {work:null,reason:'runtime_resource_budget'};
  const previousGoal=typeof a.create_payload?.previousGoal==='string'?a.create_payload.previousGoal:null;
  const house=minecraftGoal&&a.create_payload?.minecraft_goal==='wooden_house';
  const objective=house?a.objective:plan
   ? `${a.objective}\nНа этом ходу выполни ровно шаг ${plan.completed+1} из ${plan.steps.length}: ${plan.steps[plan.completed]}.
Сначала осмотри сцену.${plan.criteria?` Критерий этого шага: ${JSON.stringify(plan.criteria[plan.completed])}. Для arrival передай navigate точные координаты из критерия. Если свежий осмотр показывает, что ты уже у этой точки после предыдущего перемещения, сообщи verified=true без повторной команды.`:''} Если шаг требует осмотра или выбора точки, достаточно свежих данных: опиши, что именно подтвердилось, и поставь verified=true. Для такого шага не вызывай navigate. Если шаг требует перемещения, выбери проходимый блок на карте поверхности в 3–5 блоках по горизонтали от текущих координат и вызови navigate и ставь verified=true, когда сервер подтвердит criterion_met или verified_arrival. Не проси владельца искать игровой объект или давать координаты. Если данных не хватает, попробуй другой безопасный способ выполнить тот же шаг.`
   : minecraftGoal
    ? `${a.objective}\nПо свежей сцене реши, стоит ли начинать цель сейчас.${previousGoal?` Последняя завершённая цель: «${previousGoal}». Повторяй её только при изменившейся обстановке.`:''} Если сейчас нет полезной задачи или условия небезопасны, выбери через сколько секунд повторно осмотреть сцену и укажи причину. Если можно действовать, выбери цель, выполнимую здесь и сейчас. Составь два шага, каждый выполним за один ход. Опирайся на устойчивые элементы рельефа рядом с текущей позицией, которые видны на карте поверхности. Не выбирай цель, если для неё нужно искать отдельный предмет, растение или моба. Первый шаг — осмотр стартовой позиции с критерием grounded и минимальным здоровьем 1. Второй — перемещение с критерием arrival к проходимой точке на карте в 3–4 блоках по горизонтали. Для arrival скопируй точные координаты одной точки из arrival_candidates в результате survey. Это готовые позиции ног. Если подходящих точек нет, отложи цель.`
    : a.objective;
  const modelInput:PlanningInput={...(minecraftGoal?{minecraft_goal:true as const}:{}),...(house?{minecraft_build:'wooden_house' as const}:{}),activity:{id:a.id,objective,origin:a.origin,remaining_turns:a.max_turns===null?null:a.max_turns-a.turns_used-1,input_reply:a.input_reply??null},
   checkpoint:candidate.checkpoint,audience_id:p.audienceId,wake_reason:candidate.wake_reason,suggested_wakeup_at:new Date(Date.now()+180000).toISOString(),...candidate.context};
  const payload=requestPayload(modelInput,candidate.persona,profile);
  const review=await reviewContent(profile,'input',payload,minecraftGoal?this.gameContentReviewer():this.reviewer,this.timeoutMs,modelInput.minecraft_goal?'minecraft_goal_input':undefined);
  if(review.verdict!=='allow'){
   await this.auth.hold(p,a,profile,review);return {work:null,reason:review.rule_id};
  }
  const result=await this.runtime.claim(p,b,{profile,profile_hash:current.profile_hash,activity_id:a.id,source_hash:sourceFingerprint(a,candidate.checkpoint,candidate.persona),
   input:modelInput,persona:candidate.persona,input_hash:fingerprint(payload),review});
  return this.wrap(p,result);
 }
 private async wrap(p:Principal,result:Awaited<ReturnType<RuntimeStore['claim']>>) {
  if(!result.work)return {work:null,reason:result.reason};
  const {activity:a,turn:t,checkpoint,wake_reason}=result.work;const g=await this.auth.grant(p,t.id);
  if(!g||!await this.auth.grantValid(p,t.id))return {work:null,reason:'runtime_policy_blocked'};
  return {work:RuntimeWorkSchema.parse({activity:{id:a.id,objective:a.objective,origin:a.origin,version:a.version,max_turns:a.max_turns,turns_used:a.turns_used,input_reply:a.input_reply??null},
   turn:{id:t.id,epoch:t.epoch,lease_token:t.lease_token,lease_until:new Date(t.lease_until).toISOString()},checkpoint,audience_id:p.audienceId,persona:g.persona,wake_reason,
   authorization:{id:g.id,policy_version:g.policy_version,input_hash:g.input_hash,engine:g.engine,model:g.model,max_model_ms:g.max_model_ms},model_input:g.approved_input})};
 }
 async lease(p:Principal,input:unknown) {
  const b=WorkLeaseSchema.parse(input);
  return {valid:(await this.runtime.lease(p,b)).valid&&await this.auth.grantValid(p,b.turn_id)};
 }
 async gameLease(p:Principal,input:unknown,navigate=false,initiative=false) {
  const lease=WorkLeaseSchema.parse(input);
  const grant=await this.auth.decisionGrant(p,lease);
  return {valid:grant?.state==='started'&&(!initiative||grant.approved_input?.minecraft_goal===true)&&(!navigate||!grant.approved_input?.minecraft_goal||grant.approved_input?.minecraft_build==='wooden_house'||!!readMinecraftGoal(grant.approved_input.checkpoint))&&(await this.lease(p,lease)).valid};
 }
 async gameHousePhase(p:Principal,input:unknown){
  const lease=WorkLeaseSchema.parse(input);
  const grant=await this.auth.decisionGrant(p,lease);
  const plan=grant?.approved_input?.minecraft_build==='wooden_house'&&grant.state==='started'
   ? readMinecraftGoal(grant.approved_input.checkpoint):null;
  const criterion=plan?.criteria?.[plan.completed];
  return criterion?.kind==='house'?criterion:null;
 }
 async gameCriterionMet(p:Principal,input:unknown){
  const lease=WorkLeaseSchema.parse(input);
  const grant=await this.auth.decisionGrant(p,lease);
  const plan=grant?.approved_input?.minecraft_goal?readMinecraftGoal(grant.approved_input.checkpoint):null;
  const criterion=plan?.criteria?.[plan.completed];
  return !!criterion&&grant.state==='started'
   &&!!await this.verifiedGoalStep?.(lease.turn_id,lease.epoch,criterion,grant.activity_id);
 }
 async start(p:Principal,input:unknown){return this.auth.start(p,StartWorkSchema.parse(input));}
 async decide(p:Principal,input:unknown) {
  let b=WorkDecisionSchema.parse(input);const g=await this.auth.decisionGrant(p,b);const current=await this.auth.profile(p);
  if(!g||!current||current.profile.version!==g.policy_version||current.profile_hash!==g.profile_hash||!profileUsable(current.profile,Date.now()))throw new DomainError('runtime_policy_stale');
  const goalInput=g.approved_input?.minecraft_goal?g.approved_input:null;
  const before=goalInput?readMinecraftGoal(goalInput.checkpoint):null;
  const after=goalInput?readMinecraftGoal(b.checkpoint):null;
  if(goalInput&&!before&&after&&!goalInput.minecraft_build){
   const canonical=canonicalNavigationGoal(after);
   if(canonical)b={...b,checkpoint:JSON.stringify(canonical)};
  }
  if(goalInput&&!validMinecraftGoalDecision(goalInput,b))
   throw new DomainError('minecraft_goal_progress_invalid');
  // Older checkpoints may predate typed criteria or promise more than the
  // available evidence can establish. Never report those goals as completed.
  if(goalInput&&before&&after&&b.decision.action==='complete'&&!goalInput.minecraft_build){
   const canonical=canonicalNavigationGoal(after);
   if(!canonical)throw new DomainError('minecraft_goal_criteria_unsupported');
   b={...b,checkpoint:JSON.stringify(canonical)};
  }
  // For an already reviewed plan, retain only the progress counter and a fixed internal note.
  // Model-authored observations never enter this branch's persisted checkpoint.
  const continuation=b.decision.action==='continue'&&before&&after?{before,after}:null;
  const advanced=!!continuation&&continuation.after.completed>continuation.before.completed;
  const replayOriginal=g.state==='finished'&&g.output_hash===fingerprint(b);
  const decision=continuation&&!replayOriginal?{...b,checkpoint:JSON.stringify({...continuation.before,
   completed:continuation.after.completed,
   observation:advanced?'Шаг подтверждён наблюдением Minecraft.':'Прогресс не подтверждён. Осмотри сцену и попробуй безопасный вариант.'
  })}:b;
  const payload=decisionPayload(decision);
  if(g.state==='finished'&&g.output_hash===fingerprint(decision))return this.runtime.decide(p,decision,{grant_id:g.id,profile_version:g.policy_version,profile_hash:g.profile_hash,output_hash:g.output_hash,
   review:{verdict:'allow',rule_id:'receipt_replay',policy_version:g.policy_version,payload_hash:fingerprint(payload)}});
  if(g.state!=='started'||!(await this.runtime.lease(p,{turn_id:b.turn_id,epoch:b.epoch,lease_token:b.lease_token})).valid)throw new DomainError('runtime_approval_invalid');
  if(advanced&&!await this.verifiedGoalStep?.(b.turn_id,b.epoch,before?.criteria?.[before.completed],g.activity_id))throw new DomainError('minecraft_goal_progress_unconfirmed');
  const canonicalGoal=g.approved_input?.minecraft_goal&&b.decision.action==='complete';
  if(canonicalGoal&&(
   !readMinecraftGoal(g.approved_input.checkpoint)||b.decision.action!=='complete'||b.decision.summary!==VERIFIED_GOAL_SUMMARY
   ||readMinecraftGoal(b.checkpoint)?.observation!==VERIFIED_GOAL_SUMMARY
   ||!await this.verifiedGoalStep?.(b.turn_id,b.epoch,before?.criteria?.[before.completed],g.activity_id)))
   throw new DomainError('minecraft_goal_completion_unconfirmed');
  const canonicalArrival=!g.approved_input?.minecraft_goal&&g.approved_input?.activity?.origin==='self'&&b.decision.action==='complete'
   &&b.decision.summary===VERIFIED_NAVIGATION_SUMMARY&&b.checkpoint===VERIFIED_NAVIGATION_SUMMARY
   &&!b.desk&&!b.shared_desk&&!b.initiative;
  if(canonicalArrival&&!await this.verifiedArrival?.(b.turn_id,b.epoch))throw new DomainError('minecraft_arrival_unconfirmed');
  const localRule=canonicalGoal?'minecraft_goal_steps_verified':canonicalArrival?'minecraft_arrival_verified':
   continuation?(advanced?'minecraft_goal_step_verified':'minecraft_goal_progress_unchanged'):null;
  const review=await reviewContent(current.profile,'output',payload,
   localRule
    ? async request=>({verdict:'allow',rule_id:localRule,policy_version:request.policy_version,payload_hash:request.payload_hash})
    : goalInput?this.gameContentReviewer():this.reviewer,this.timeoutMs,g.approved_input?.minecraft_goal&&!b.desk&&!b.shared_desk&&!b.initiative?'minecraft_checkpoint':undefined);
  if(review.verdict!=='allow'){await this.auth.outputDenied(p,b.turn_id,review);throw new DomainError('runtime_output_blocked');}
  return this.runtime.decide(p,decision,{grant_id:g.id,profile_version:g.policy_version,profile_hash:g.profile_hash,output_hash:fingerprint(decision),review});
 }
 async reviewQueue(p:Principal){return this.auth.reviewQueue(p);}
 async retryReview(p:Principal,input:unknown){return this.auth.retryReview(p,z.object({request_id:z.uuid(),activity_id:z.uuid(),activity_version:z.number().int().positive(),policy_version:z.string().min(1).max(100),payload_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(input));}
 async executionEnabled(p:Principal){const current=await this.auth.profile(p);return (!!this.reviewer||this.skipMinecraftContentReview)&&!!current&&profileUsable(current.profile,Date.now());}
 async overview(p:Principal){return this.auth.overview(p);}
 async usage(p:Principal,input:unknown){return this.auth.usage(p,UsageSchema.parse(input));}
}
