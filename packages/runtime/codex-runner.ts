import {setTimeout as delay} from 'node:timers/promises';
import {compactRuntimeSurface,minecraftArrivalCandidates,minecraftHouseSites} from '../minecraft/runtime-view.ts';
import type { CodexRpc } from '../codex/rpc.ts';
import { abortable, type RuntimeGameCall } from './consumer.ts';
import { ACTIVITY_DECIDE_TOOL, minecraftPlanningInstructions, MinecraftGoalDraft, MinecraftGoalDelay, MinecraftGoalWait, MinecraftStepOutput, minecraftGoalOutputSchema, readMinecraftGoal, validMinecraftGoalDecision, VERIFIED_NAVIGATION_SUMMARY, VERIFIED_GOAL_SUMMARY, PlanningDecisionSchema, type PlanningDecision, type PlanningInput } from './protocol.ts';

export type PlanningRpc=Pick<CodexRpc,'request'|'onRequest'|'onNotification'>;

export async function runCodexPlanning(rpc:PlanningRpc,cwd:string,model:string,input:PlanningInput,persona:string,signal:AbortSignal,onUsage?:(totalTokens:number)=>void,game?:RuntimeGameCall):Promise<PlanningDecision> {
  signal.throwIfAborted();
  const gameActions=input.minecraft_build
    ? ['survey','observe','navigate','speak','build','build_status']
    : input.minecraft_goal?['survey','observe','navigate','path_status','speak']:['observe','surface','navigate','path_status'];
  const gameTool={type:'function',name:'activity_minecraft',
    description:'Use catalog to list every UnionClef tool and its arguments, then call to invoke one by name. The dedicated actions help collect goal evidence, survey terrain, and track navigation or construction. A returned request may still be running.',
    inputSchema:{type:'object',properties:{
      action:{type:'string',enum:[...gameActions,'catalog','call']},
      name:{type:'string'},
      arguments:{type:'object',additionalProperties:true},
      target:{type:'object',properties:{x:{type:'integer'},y:{type:'integer'},z:{type:'integer'}},required:['x','y','z'],additionalProperties:false},
      text:{type:'string',maxLength:160}
    },required:['action'],additionalProperties:false}};
  const savedGoal=input.minecraft_goal?readMinecraftGoal(input.checkpoint):null;
  let finalText:string|undefined;
  let arrivalCandidates:ReturnType<typeof minecraftArrivalCandidates>=[];
  let houseSites:ReturnType<typeof minecraftHouseSites>=[];
  let buildRequested=false;
  let verifiedArrival=false, observed=false, navigationRequested=false, spoke=false, criterionMet=false;
  let threadId:string|undefined,turnId:string|undefined,result:PlanningDecision|undefined;
  let resolve:()=>void=()=>{},reject:(error:Error)=>void=()=>{};
  const finished=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  void finished.catch(()=>{});
  const interrupt=()=>{if(threadId&&turnId)void rpc.request('turn/interrupt',{threadId,turnId}).catch(()=>{});};
  const abort=()=>{interrupt();reject(new Error('runtime_turn_revoked'));};
  signal.addEventListener('abort',abort,{once:true});
  rpc.onRequest=async(method,p)=>{
    signal.throwIfAborted();
    if(method!=='item/tool/call'||!threadId||!turnId||p.threadId!==threadId||p.turnId!==turnId)throw new Error('runtime_tool_denied');
    if(result)throw new Error('activity_already_decided');
    if(game&&p.tool===gameTool.name){
      try{
        const action=p.arguments?.action;
        if(![...gameActions,'catalog','call'].includes(action))
          throw new Error('runtime_game_action_denied');
        let output:unknown;
        if(action==='catalog'){
          output=await game({action:'catalog'});
        }else if(action==='call'){
          output=await game({action:'call',name:p.arguments?.name,arguments:p.arguments?.arguments,call_id:p.callId});
        }else if(input.minecraft_goal&&(action==='survey'||action==='observe')){
          const [scene,surface]=await Promise.all([
            game({action:'observe'}),
            action==='survey'?game({action:input.minecraft_build?'house_surface':'surface'}):Promise.resolve(null)
          ]);
          const world=scene as {connected?:boolean;snapshot?:{self?:Record<string,unknown>;playerCount?:number};nearby_players?:number;criterion_met?:boolean};
          observed=world.connected===true;
          criterionMet=observed&&world.criterion_met===true;
          const self=world.snapshot?.self;
          if(observed&&typeof self?.pos==='string'){
            const position=self.pos.split(',').map(Number);
            if(!savedGoal&&surface&&position.length===3&&position.every(Number.isFinite)){
              if(input.minecraft_build)houseSites=minecraftHouseSites(surface,position);
              arrivalCandidates=minecraftArrivalCandidates(surface,position);
            }
          }
          output={connected:observed,self:self?{pos:self.pos,hp:self.hp,food:self.food,ground:self.onGround,
            dimension:self.dimension,looking_at:self.lookingAt}:null,players:world.snapshot?.playerCount,nearby_players:world.nearby_players??0,criterion_met:criterionMet,
            ...(surface&&observed?{surface:compactRuntimeSurface(surface),...(!savedGoal?(input.minecraft_build?{house_sites:houseSites,arrival_candidates:arrivalCandidates}:{arrival_candidates:arrivalCandidates}): {})}:{})};
        }else if(input.minecraft_build&&action==='build'){
          if(!observed||buildRequested)throw new Error('minecraft_build_unavailable');
          buildRequested=true;
          const request=await game({action:'build'});
          output=request;
          if(request&&typeof request==='object'&&'state' in request&&request.state==='returned'){
            for(let i=0;i<6;i++){
              await delay(1800,undefined,{signal});
              const progress=await game({action:'build_status'}) as {complete?:boolean};
              output={request,progress};
              if(progress.complete){criterionMet=true;break}
            }
          }
        }else if(input.minecraft_goal&&action==='speak'){
          if(!observed||spoke||navigationRequested)throw new Error('minecraft_initiative_unavailable');
          spoke=true;
          output=await game(p.arguments);
        }else if(input.minecraft_goal&&action==='navigate'){
          if(input.minecraft_build&&savedGoal)throw new Error('minecraft_house_use_builder');
          if(navigationRequested)throw new Error('minecraft_navigation_already_requested');
          const criterion=savedGoal?.criteria?.[savedGoal.completed];
          if(criterion){
            const target=p.arguments?.target;
            if(criterion.kind!=='arrival'||target?.x!==criterion.x||target?.y!==criterion.y||target?.z!==criterion.z){
              return {success:false,contentItems:[{type:'inputText',text:'Use the exact coordinates in the saved arrival criterion. Observation steps do not require movement.'}]};
            }
          }
          navigationRequested=true;
          const request=await game(p.arguments);
          if(request&&typeof request==='object'&&'target_too_close' in request){
            navigationRequested=false;
            return {success:false,contentItems:[{type:'inputText',text:JSON.stringify({
              ...request,instruction:'No movement command was sent. Pick a different safe surface cell at least 3 horizontal blocks from origin and retry.'
            })}]};
          }
          let status:{verified_arrival?:boolean;status?:{busy?:boolean;pos?:string}}={};
          for(let attempt=0;attempt<6;attempt++){
            status=await game({action:'path_status'}) as typeof status;
            if(status.verified_arrival||status.status?.busy!==true)break;
            if(attempt<5)await delay(650,undefined,{signal});
          }
          verifiedArrival=status.verified_arrival===true;
          output={verified_arrival:verifiedArrival,busy:status.status?.busy,pos:status.status?.pos};
        }else{
          if(action==='navigate')navigationRequested=true;
          output=await game(p.arguments);
          if(action==='path_status'&&output&&typeof output==='object'&&'verified_arrival' in output)
            verifiedArrival=output.verified_arrival===true;
        }
        const content=JSON.stringify(output);
        const upstreamError=action==='call'&&(output as {state?:string;result?:{isError?:boolean}})?.result?.isError===true;
        const unknown=action==='call'&&(output as {state?:string})?.state==='unknown';
        return {success:!upstreamError&&!unknown,contentItems:[{type:'inputText',text:action==='catalog'?content:content.slice(0,12000)}]};
      }catch{
        return {success:false,contentItems:[{type:'inputText',text:'Minecraft request unavailable or outcome uncertain. Observe state before reporting progress. Do not repeat an action whose outcome is uncertain.'}]};
      }
    }
    if(input.minecraft_goal||p.tool!==ACTIVITY_DECIDE_TOOL.name)throw new Error('runtime_tool_denied');
    const proposed=PlanningDecisionSchema.parse(p.arguments);
    result=proposed;
    if(!input.minecraft_goal&&input.activity.origin==='self'&&verifiedArrival&&result.decision.action==='complete')
      result={checkpoint:VERIFIED_NAVIGATION_SUMMARY,decision:{action:'complete',summary:VERIFIED_NAVIGATION_SUMMARY}};
    return {success:true,contentItems:[{type:'inputText',text:'Decision recorded locally; core must accept it.'}]};
  };
  rpc.onNotification=(method,p)=>{
    if(!threadId||p.threadId!==threadId)return;
    if(method==='turn/started'){
      if(turnId&&turnId!==p.turn?.id)return;
      turnId=p.turn.id;if(signal.aborted)interrupt();
    }
    if(method==='item/completed'&&p.turnId===turnId&&p.item?.type==='agentMessage'&&p.item.phase==='final_answer')
      finalText=p.item.text;
    if(method==='thread/tokenUsage/updated'&&p.turnId===turnId){const total=p.tokenUsage?.total?.totalTokens;if(Number.isSafeInteger(total)&&total>=0)onUsage?.(total);}
    if(method==='turn/completed'&&p.turn?.id===turnId){
      if(p.turn.status==='completed')resolve();
      else reject(Object.assign(new Error('codex_turn_failed'),{turn:p.turn}));
    }
  };
  try {
    const start=await abortable(rpc.request('thread/start',{ephemeral:true,environments:[],runtimeWorkspaceRoots:[],cwd,sandbox:'read-only',approvalPolicy:'never',
      model,baseInstructions:persona,developerInstructions:minecraftPlanningInstructions(input),
      dynamicTools:[...(!input.minecraft_goal?[{type:'function',...ACTIVITY_DECIDE_TOOL}]:[]),...(game?[gameTool]:[])]}),signal);
    threadId=start.thread.id;
    signal.throwIfAborted();
    const starting=rpc.request('turn/start',{threadId,input:[{type:'text',text:JSON.stringify(input)}],effort:'low',summary:'none',...(input.minecraft_goal?{outputSchema:minecraftGoalOutputSchema(input)}:{})}).then(response=>{
      turnId=response.turn.id;if(signal.aborted)interrupt();return response;
    });
    await abortable(starting,signal);
    await abortable(finished,signal);
    signal.throwIfAborted();
    if(input.minecraft_goal&&finalText){
      const body:unknown=JSON.parse(finalText);
      if(savedGoal){
        const report=MinecraftStepOutput.parse(body);
        const criterion=savedGoal.criteria?.[savedGoal.completed];
        const verified=criterion?criterionMet||(criterion.kind==='arrival'&&verifiedArrival):report.verified;
        const completed=savedGoal.completed+(verified?1:0);
        const complete=completed===savedGoal.steps.length;
        result={checkpoint:JSON.stringify({...savedGoal,completed,observation:complete?VERIFIED_GOAL_SUMMARY:report.observation}),
          decision:complete?{action:'complete',summary:VERIFIED_GOAL_SUMMARY}:!verified&&report.question?{action:'request_input',question:report.question}:{action:'continue'}};
      }else{
        const {retry_after_seconds,...proposal}=body as {retry_after_seconds:unknown;goal:unknown;steps:unknown;criteria:unknown;observation:unknown};
        if(retry_after_seconds===null){
          const draft=MinecraftGoalDraft.parse(proposal);
          const arrival=draft.criteria.find(criterion=>criterion.kind==='arrival');
          const house=draft.criteria.find(criterion=>criterion.kind==='house');
          if(house&&!houseSites.some(site=>site.x===house.x&&site.y===house.y&&site.z===house.z)){
            result={checkpoint:JSON.stringify({deferred_reason:'Участок дома отсутствует среди известных ровных площадок.'}),
              decision:{action:'wait_until',at:new Date(Date.now()+30_000).toISOString()}};
          }
          if(arrival&&!arrivalCandidates.some(target=>target.x===arrival.x&&target.y===arrival.y&&target.z===arrival.z)){
            result={checkpoint:JSON.stringify({deferred_reason:'Точка маршрута не совпадает с проверенными клетками карты. При следующем осмотре выбери точку из arrival_candidates.'}),
              decision:{action:'wait_until',at:new Date(Date.now()+30_000).toISOString()}};
          }
          result??={checkpoint:JSON.stringify({...draft,completed:0}),decision:{action:'continue'}};
        }else{
          if(proposal.goal!==null||!Array.isArray(proposal.steps)||proposal.steps.length||!Array.isArray(proposal.criteria)||proposal.criteria.length)throw new Error('minecraft_goal_wait_invalid');
          const seconds=MinecraftGoalDelay.parse(retry_after_seconds);
          const wait=MinecraftGoalWait.parse({deferred_reason:proposal.observation});
          result={checkpoint:JSON.stringify(wait),decision:{action:'wait_until',at:new Date(Date.now()+seconds*1000).toISOString()}};
        }
      }
      const after=readMinecraftGoal(result.checkpoint);
      const needsEvidence=!savedGoal||(after?.completed??0)>savedGoal.completed;
      if(!validMinecraftGoalDecision(input,result)||(needsEvidence&&(!observed||(navigationRequested&&!verifiedArrival))))
        throw new Error('minecraft_goal_progress_unconfirmed');
    }
    if(!result)throw new Error('activity_decision_missing');
    return result;
  } finally {
    if(signal.aborted)interrupt();
    signal.removeEventListener('abort',abort);
    rpc.onNotification=()=>{};
    rpc.onRequest=async()=>{throw new Error('no_active_turn');};
  }
}
