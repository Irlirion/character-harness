import { toolDescription } from '../domain/tool-descriptions.ts';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DecisionSchema,DeskWriteSchema,InitiativeSchema } from './contracts.ts';

export const WorkLeaseSchema = z.object({turn_id:z.uuid(),epoch:z.number().int().positive(),lease_token:z.uuid()}).strict();
export const PlanningDecisionSchema = z.object({checkpoint:z.string().max(16000),decision:DecisionSchema,desk:DeskWriteSchema.optional(),shared_desk:DeskWriteSchema.optional(),initiative:InitiativeSchema.optional()}).strict();
export type PlanningDecision = z.infer<typeof PlanningDecisionSchema>;
export const PlanningInputSchema=z.object({
 activity:z.object({id:z.string(),objective:z.string(),origin:z.enum(['owner','self']),remaining_turns:z.number().int().nonnegative().nullable(),input_reply:z.string().nullable()}).strict(),
 shared_desk:z.object({revision:z.number().int().positive(),notes:z.string().max(4000),plan:z.string().max(2000)}).strict().optional(),
 desk:z.object({revision:z.number().int().positive(),notes:z.string(),plan:z.string()}).strict().optional(),
 autonomy:z.object({revision:z.number().int().positive(),posting_allowed:z.boolean(),observed_at:z.string(),context:z.string()}).strict().optional(),
 minecraft_goal:z.literal(true).optional(),
 minecraft_build:z.literal('wooden_house').optional(),
 checkpoint:z.string().max(16000).nullable(),audience_id:z.string(),wake_reason:z.string(),suggested_wakeup_at:z.iso.datetime({offset:true}),
}).strict();
export const AuthorizationSchema=z.object({id:z.uuid(),policy_version:z.string(),input_hash:z.string().regex(/^[a-f0-9]{64}$/),engine:z.enum(['pi','codex']),model:z.string(),max_model_ms:z.number().int().min(100).max(75000)}).strict();
export const RuntimeWorkSchema = z.object({
  activity:z.object({id:z.uuid(),objective:z.string().max(4000),origin:z.enum(['owner','self']),version:z.number().int().positive(),
    max_turns:z.number().int().positive().nullable(),turns_used:z.number().int().positive(),input_reply:z.string().nullable()}),
  turn:z.object({id:z.uuid(),epoch:z.number().int().positive(),lease_token:z.uuid(),lease_until:z.iso.datetime({offset:true})}),
 checkpoint:z.string().max(16000).nullable(),audience_id:z.string(),persona:z.string(),wake_reason:z.string(),
  authorization:AuthorizationSchema.optional(),model_input:PlanningInputSchema.optional(),
});
export type RuntimeWork = z.infer<typeof RuntimeWorkSchema>;
export const NextWorkSchema = z.object({work:RuntimeWorkSchema.nullable(),reason:z.string().optional()});
export type PlanningInput = z.infer<typeof PlanningInputSchema>;
export function planningInput(work: RuntimeWork):PlanningInput {
  if(work.model_input)return work.model_input;
  return {activity:{id:work.activity.id,objective:work.activity.objective,origin:work.activity.origin,
    remaining_turns:work.activity.max_turns===null?null:work.activity.max_turns-work.activity.turns_used,input_reply:work.activity.input_reply},
    checkpoint:work.checkpoint,audience_id:work.audience_id,wake_reason:work.wake_reason,
    suggested_wakeup_at:new Date(Date.now()+180000).toISOString()};
}
export const PLANNING_INSTRUCTIONS = readFileSync(new URL('./planning.md',import.meta.url),'utf8').trimEnd();
export const ACTIVITY_DECIDE_TOOL = {name:'activity_decide',description:toolDescription('activity-save-a-checkpoint-and-choose'),inputSchema:z.toJSONSchema(PlanningDecisionSchema,{target:'draft-7'})};

export function runtimeEngineEnabled(value: string | undefined): boolean {
  if (value===undefined || value==='false') return false;
  if (value==='true') return true;
  throw new Error('RUNTIME_ENGINE_ENABLED must be true or false');
}

export const StartWorkSchema=WorkLeaseSchema.extend({grant_id:z.uuid(),input_hash:z.string().regex(/^[a-f0-9]{64}$/),engine:z.enum(['pi','codex']),model:z.string().min(1).max(200)}).strict();
export const UsageSchema=WorkLeaseSchema.extend({total_tokens:z.number().int().min(0).max(1000000000).nullable(),source:z.enum(['pi_session','codex_notification'])}).strict();

/** Reviewer-backed claim/commit can take longer than ordinary core reads. */
export function runtimeRequestTimeout(path:string,ordinaryMs:number){return path==='/engine/next_work'||path==='/engine/work_decision'?65000:ordinaryMs;}

export const VERIFIED_NAVIGATION_SUMMARY = 'Лада дошла до выбранной точки. Прибытие подтверждено Minecraft.';

const MinecraftCoordinate=z.number().int();
export const MinecraftGoalCriterion=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('grounded'),min_health:z.number().int().min(1).max(20)}).strict(),
 z.object({kind:z.literal('arrival'),x:MinecraftCoordinate,y:MinecraftCoordinate,z:MinecraftCoordinate}).strict(),
 z.object({kind:z.literal('house'),phase:z.enum(['floor','walls','roof']),size:z.literal('7x5').optional(),x:MinecraftCoordinate,y:MinecraftCoordinate,z:MinecraftCoordinate}).strict()
]);
export type MinecraftGoalCriterion=z.infer<typeof MinecraftGoalCriterion>;
const MinecraftGoalFields = z.object({
 goal:z.string().trim().min(1).max(200),
 steps:z.array(z.string().trim().min(1).max(200)).min(2).max(4),
 observation:z.string().trim().min(1).max(600),
}).strict();
export const MinecraftGoalDraft=MinecraftGoalFields.extend({criteria:z.array(MinecraftGoalCriterion).min(2).max(4)})
 .refine(plan=>plan.criteria.length===plan.steps.length);
export const MinecraftGoalDelay=z.number().int().min(30).max(1800);
export const MinecraftGoalWait=z.object({deferred_reason:z.string().trim().min(1).max(600)}).strict();
export const MinecraftGoalCheckpoint=MinecraftGoalFields.extend({
 completed:z.number().int().nonnegative(),
 criteria:z.array(MinecraftGoalCriterion).optional()
}).refine(plan=>plan.completed<=plan.steps.length&&(!plan.criteria||plan.criteria.length===plan.steps.length));

export function readMinecraftGoal(checkpoint:string|null){
 try{return MinecraftGoalCheckpoint.parse(JSON.parse(checkpoint??''));}
 catch{return null;}
}

export function canonicalNavigationGoal(plan:z.infer<typeof MinecraftGoalCheckpoint>){
 const criteria=plan.criteria;
 if(!criteria||criteria.length!==2||criteria[0].kind!=='grounded'||criteria[1].kind!=='arrival')return null;
 const ground=criteria[0],target=criteria[1];
 return {...plan,goal:`Дойти до точки (${target.x}, ${target.y}, ${target.z}).`,
  steps:[`Проверить опору и здоровье не ниже ${ground.min_health}.`,
   `Переместиться к точке (${target.x}, ${target.y}, ${target.z}) и подтвердить прибытие.`]};
}

export function validMinecraftGoalDecision(input:PlanningInput, decision:PlanningDecision):boolean {
 const before=readMinecraftGoal(input.checkpoint), after=readMinecraftGoal(decision.checkpoint);
 if(decision.desk||decision.shared_desk||decision.initiative)return false;
 if(!before&&decision.decision.action==='wait_until'){
  try{return MinecraftGoalWait.safeParse(JSON.parse(decision.checkpoint)).success}
  catch{return false}
 }
 if(!after)return false;
 if(!before&&input.minecraft_build){
  const criteria=after.criteria;
  if(!criteria||criteria.length!==3)return false;
  const base=criteria[0];
  if(base.kind!=='house'||!criteria.every((c,i)=>c.kind==='house'&&c.phase===['floor','walls','roof'][i]&&c.size==='7x5'
   &&c.x===base.x&&c.y===base.y&&c.z===base.z))return false;
 }else if(!before&&!canonicalNavigationGoal(after))return false;
 if(!before)return decision.decision.action==='continue'&&!!after.criteria&&after.completed===0&&(input.activity.remaining_turns===null||after.steps.length<=input.activity.remaining_turns);
 return before.goal===after.goal&&JSON.stringify(before.steps)===JSON.stringify(after.steps)
  &&JSON.stringify(before.criteria)===JSON.stringify(after.criteria)
  &&after.completed>=before.completed&&after.completed<=before.completed+1
  &&(decision.decision.action==='complete'?after.completed===after.steps.length:after.completed<after.steps.length);
}

export const MINECRAFT_GOAL_INSTRUCTIONS = readFileSync(new URL('./minecraft-goal.md',import.meta.url),'utf8').trimEnd();

export const MinecraftStepOutput=z.object({
 observation:z.string().trim().min(1).max(600),verified:z.boolean(),
 question:z.string().trim().min(1).max(600).nullable()
}).strict().refine(report=>!report.verified||!report.question);

export function minecraftGoalOutputSchema(input:PlanningInput){
 const properties=readMinecraftGoal(input.checkpoint)
  ? {observation:{type:'string'},verified:{type:'boolean'},question:{type:['string','null']}}
  : {goal:{type:['string','null']},steps:{type:'array',items:{type:'string'}},criteria:{type:'array',items:{anyOf:[
    {type:'object',properties:{kind:{type:'string',enum:['grounded']},min_health:{type:'integer'}},required:['kind','min_health'],additionalProperties:false},
    {type:'object',properties:{kind:{type:'string',enum:['arrival']},x:{type:'integer'},y:{type:'integer'},z:{type:'integer'}},required:['kind','x','y','z'],additionalProperties:false},
    ...(input.minecraft_build?[{type:'object',properties:{kind:{type:'string',enum:['house']},phase:{type:'string',enum:['floor','walls','roof']},size:{type:'string',enum:['7x5']},x:{type:'integer'},y:{type:'integer'},z:{type:'integer'}},required:['kind','phase','size','x','y','z'],additionalProperties:false}]:[])
   ]}},observation:{type:'string'},retry_after_seconds:{type:['integer','null']}};
 return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};
}

export function minecraftPlanningInstructions(input:PlanningInput):string {
 if(!input.minecraft_goal)return PLANNING_INSTRUCTIONS;
 if(input.minecraft_build)return MINECRAFT_GOAL_INSTRUCTIONS+(readMinecraftGoal(input.checkpoint)
  ? readFileSync(new URL('./planning-variant-0.md',import.meta.url),'utf8')
  : readFileSync(new URL('./planning-variant-1.md',import.meta.url),'utf8'));
 return MINECRAFT_GOAL_INSTRUCTIONS+readFileSync(new URL('./planning-variant-2.md',import.meta.url),'utf8')
  +(readMinecraftGoal(input.checkpoint)
   ? readFileSync(new URL('./planning-variant-3.md',import.meta.url),'utf8')
   : readFileSync(new URL('./planning-variant-4.md',import.meta.url),'utf8'));
}

export const VERIFIED_GOAL_SUMMARY = 'Все запланированные шаги игровой цели выполнены.';
