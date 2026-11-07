import type { CodexRpc } from '../codex/rpc.ts';
import { abortable } from './consumer.ts';
import { ACTIVITY_DECIDE_TOOL, PLANNING_INSTRUCTIONS, PlanningDecisionSchema, type PlanningDecision, type PlanningInput } from './protocol.ts';

export type PlanningRpc=Pick<CodexRpc,'request'|'onRequest'|'onNotification'>;

export async function runCodexPlanning(rpc:PlanningRpc,cwd:string,model:string,input:PlanningInput,persona:string,signal:AbortSignal,onUsage?:(totalTokens:number)=>void):Promise<PlanningDecision> {
  signal.throwIfAborted();
  let threadId:string|undefined,turnId:string|undefined,result:PlanningDecision|undefined;
  let resolve:()=>void=()=>{},reject:(error:Error)=>void=()=>{};
  const finished=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  void finished.catch(()=>{});
  const interrupt=()=>{if(threadId&&turnId)void rpc.request('turn/interrupt',{threadId,turnId}).catch(()=>{});};
  const abort=()=>{interrupt();reject(new Error('runtime_turn_revoked'));};
  signal.addEventListener('abort',abort,{once:true});
  rpc.onRequest=async(method,p)=>{
    signal.throwIfAborted();
    if(method!=='item/tool/call'||!threadId||!turnId||p.threadId!==threadId||p.turnId!==turnId||p.tool!==ACTIVITY_DECIDE_TOOL.name)throw new Error('runtime_tool_denied');
    if(result)throw new Error('activity_already_decided');
    result=PlanningDecisionSchema.parse(p.arguments);
    return {success:true,contentItems:[{type:'inputText',text:'Decision recorded locally; core must accept it.'}]};
  };
  rpc.onNotification=(method,p)=>{
    if(!threadId||p.threadId!==threadId)return;
    if(method==='turn/started'){
      if(turnId&&turnId!==p.turn?.id)return;
      turnId=p.turn.id;if(signal.aborted)interrupt();
    }
    if(method==='thread/tokenUsage/updated'&&p.turnId===turnId){const total=p.tokenUsage?.total?.totalTokens;if(Number.isSafeInteger(total)&&total>=0)onUsage?.(total);}
    if(method==='turn/completed'&&p.turn?.id===turnId){
      if(p.turn.status==='completed')resolve();
      else reject(Object.assign(new Error('codex_turn_failed'),{turn:p.turn}));
    }
  };
  try {
    const start=await abortable(rpc.request('thread/start',{ephemeral:true,environments:[],runtimeWorkspaceRoots:[],cwd,sandbox:'read-only',approvalPolicy:'never',
      model,baseInstructions:persona,developerInstructions:PLANNING_INSTRUCTIONS,
      dynamicTools:[{type:'function',...ACTIVITY_DECIDE_TOOL}]}),signal);
    threadId=start.thread.id;
    signal.throwIfAborted();
    const starting=rpc.request('turn/start',{threadId,input:[{type:'text',text:JSON.stringify(input)}],effort:'low',summary:'none'}).then(response=>{
      turnId=response.turn.id;if(signal.aborted)interrupt();return response;
    });
    await abortable(starting,signal);
    await abortable(finished,signal);
    signal.throwIfAborted();
    if(!result)throw new Error('activity_decision_missing');
    return result;
  } finally {
    if(signal.aborted)interrupt();
    signal.removeEventListener('abort',abort);
    rpc.onNotification=()=>{};
    rpc.onRequest=async()=>{throw new Error('no_active_turn');};
  }
}
