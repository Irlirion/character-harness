import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { abortable } from './consumer.ts';
import { ACTIVITY_DECIDE_TOOL, PLANNING_INSTRUCTIONS, PlanningDecisionSchema, type PlanningDecision, type PlanningInput } from './protocol.ts';

export type PlanningSession={stats?:()=>number;prompt:(text:string)=>Promise<unknown>;abort:()=>Promise<unknown>;dispose:()=>void};
export type PlanningSessionFactory=(systemPrompt:string,tools:ToolDefinition[])=>Promise<PlanningSession>;

export async function runPiPlanning(factory:PlanningSessionFactory,input:PlanningInput,persona:string,signal:AbortSignal,onUsage?:(totalTokens:number)=>void):Promise<PlanningDecision> {
  signal.throwIfAborted();
  let result:PlanningDecision|undefined;
  const tool:ToolDefinition={name:ACTIVITY_DECIDE_TOOL.name,label:ACTIVITY_DECIDE_TOOL.name,description:ACTIVITY_DECIDE_TOOL.description,
    parameters:ACTIVITY_DECIDE_TOOL.inputSchema as ToolDefinition['parameters'],execute:async(_id,args)=>{
      signal.throwIfAborted();
      if(result)throw new Error('activity_already_decided');
      result=PlanningDecisionSchema.parse(args);
      return {content:[{type:'text',text:'Decision recorded locally; core must accept it.'}],details:{}};
    }};
  const session=await factory(`${persona}\n${PLANNING_INSTRUCTIONS}`,[tool]);
  const abort=()=>{void session.abort().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    signal.throwIfAborted();
    await abortable(session.prompt(JSON.stringify(input)),signal);
    signal.throwIfAborted();
    if(!result)throw new Error('activity_decision_missing');
    return result;
  } finally {if(session.stats){try{onUsage?.(session.stats());}catch{}}signal.removeEventListener('abort',abort);session.dispose();}
}
