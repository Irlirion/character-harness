import { toolDescription } from '../../packages/domain/tool-descriptions.ts';
import { readFileSync } from 'node:fs';
import {deliverCodexProfileToolResult} from '../../packages/telegram/profile-tool-content.ts';
import { RuntimeConsumer } from '../../packages/runtime/consumer.ts';
import { runtimeEngineEnabled, runtimeRequestTimeout } from '../../packages/runtime/protocol.ts';
import { runCodexPlanning } from '../../packages/runtime/codex-runner.ts';
import { runImageLoop } from './images.ts';
import { IMAGE_INSTRUCTIONS } from '../../packages/images/domain.ts';
import { TELEGRAM_INSTRUCTIONS,parseTelegramDecision,telegramOutputSchema } from '../../packages/telegram/domain.ts';
import { coreBaseUrl, coreFetch } from '../../packages/domain/core-http.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CodexRpc } from '../../packages/codex/rpc.ts';
import { configureCodex } from '../../packages/codex/config.ts';
import { selectConfiguredModel } from '../../packages/codex/model.ts';
import { handleAttemptFailure } from '../../packages/codex/backoff.ts';
import { makeTurnInput } from '../../packages/domain/conversation-context.ts';
import { TurnFinishDecisionSchema, type TurnFinishDecision } from '../../packages/domain/turn-decision.ts';
import { secret } from '../../packages/domain/secrets.ts';
import { MINECRAFT_WORKSPACE_INSTRUCTIONS } from '../../packages/codex/instructions.ts';
const renderInstruction=(name:string,values:unknown[])=>readFileSync(new URL('./'+name,import.meta.url),'utf8').replace(/\{\{(\d+)\}\}/g,(_m,index)=>String(values[Number(index)]));
const enableRuntimeEngine=runtimeEngineEnabled(process.env.RUNTIME_ENGINE_ENABLED);
const runtimeStop=new AbortController();
const home=process.env.HARNESS_CODEX_HOME??'/data/codex';
const cwd=process.env.HARNESS_CODEX_WORKSPACE??'/data/workspace';
await configureCodex(home,cwd);
const rpc=new CodexRpc(process.env.CODEX_BIN??'/app/node_modules/.bin/codex',cwd,home);
const base=coreBaseUrl(process.env.CORE_URL??'http://core:3000');
const headers={Authorization:`Bearer ${secret('ENGINE_TOKEN')}`,'Content-Type':'application/json'};
async function api(path:string,body?:unknown){
 const r=await coreFetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(runtimeRequestTimeout(path,5000))});
 if(!r.ok)throw new Error('core_request_failed');return r.json();
}
let stopped=false;let threadId:string|undefined;let turnId:string|undefined;let engineState:'starting'|'ready'|'busy'|'degraded'|'stopping'='starting';let engineErrorCode:string|null=null;
const sendHeartbeat=()=>api('/engine/heartbeat',{component:'codex-engine',state:engineState,error_code:engineErrorCode});
const heartbeatTimer=setInterval(()=>{void sendHeartbeat().catch(()=>{});},10000);heartbeatTimer.unref();
let wakeSleep:(()=>void)|undefined;
let stopImages:()=>void=()=>{};
const stop=()=>{stopped=true;engineState='stopping';void sendHeartbeat().catch(()=>{});clearInterval(heartbeatTimer);runtimeStop.abort();stopImages();wakeSleep?.();rpc.close();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
await rpc.initialize();
const auth=await rpc.request('account/read',{refreshToken:false});
if(auth.account?.type!=='chatgpt'){rpc.close();throw new Error('Run the isolated Codex ChatGPT login first');}
const models=await rpc.request('model/list',{});
const selected=selectConfiguredModel(models.data,process.env.CODEX_MODEL??'gpt-6-luna');
console.log(JSON.stringify({event:'codex_engine_ready',model:selected.model??selected.id}));
engineState='ready';void sendHeartbeat().catch(()=>{});
if(process.env.TELEGRAM_IMAGES_ENABLED==='true')void runImageLoop({base,headers,home,cwd,model:selected.model??selected.id,stopped:()=>stopped,registerStop:close=>{stopImages=close;}});
// A long quota cooldown must not hold the process open: shutdown resolves it immediately.
const sleep=(ms:number)=>new Promise<void>(resolve=>{
 if(stopped){resolve();return;}
 const done=()=>{wakeSleep=undefined;clearTimeout(timer);resolve();};
 const timer=setTimeout(done,ms);
 wakeSleep=done;
});
const runtime=enableRuntimeEngine?new RuntimeConsumer(api,{engine:'codex',model:selected.model??selected.id}):undefined;
while(!stopped){
  const client=new Client({name:'codex-harness-bridge',version:'0.1.0'});
  let pendingEventId:string|undefined;
  let pendingEpoch:number|undefined;
  let finishDecision:TurnFinishDecision|undefined;
  try{
   const input=await api('/engine/input');engineState='ready';engineErrorCode=null;if(!input.event){
    if(runtime){engineState='busy';void sendHeartbeat().catch(()=>{});try{await runtime.tick((context,persona,signal,onUsage,game)=>runCodexPlanning(rpc,cwd,selected.model??selected.id,context,persona,signal,onUsage,process.env.RUNTIME_MINECRAFT_ENABLED==='true'?game:undefined),runtimeStop.signal);}finally{engineState='ready';}}
    await sleep(1000);continue;
   }
   engineState='busy';void sendHeartbeat().catch(()=>{});
   pendingEventId=input.event.id;
   pendingEpoch=input.character.epoch;
  const isTelegram=input.event.channel==='telegram';
  const turnHeaders={...headers,'X-Harness-Event':input.event.id,'X-Harness-Epoch':String(input.character.epoch)};
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{fetch:coreFetch,requestInit:{headers:turnHeaders}}));
  const catalog=(await client.listTools()).tools;
  const allowed=new Set(['agent_approach_player','agent_turn','agent_action_status','minecraft_tools','minecraft_call','minecraft_stop','agent_get_status','agent_observe','memory_search','memory_propose','memory_stage_delta','memory_social_list','telegram_read_history','telegram_group_participants','telegram_member_profile','telegram_groups','telegram_send_group','telegram_group_delivery','image_generate','image_generation_status','turn_finish']);
  if(catalog.some(t=>!allowed.has(t.name)))throw new Error('unexpected_catalog');
  rpc.onRequest=async(method,p)=>{
   if(method!=='item/tool/call' || p.threadId!==threadId || !allowed.has(p.tool))throw new Error('tool_denied');
   if(p.tool==='turn_finish'){
    if(finishDecision)throw new Error('turn_already_finished');
    finishDecision=TurnFinishDecisionSchema.parse(p.arguments);
    return {success:true,contentItems:[{type:'inputText',text:finishDecision.decision==='silent'?'Turn finished silently.':'Reply accepted.'}]};
   }
   if(finishDecision)throw new Error('turn_already_finished');
   const args={...p.arguments};
   if(p.tool==='memory_propose'){args.epoch=input.character.epoch;args.invocation_id=`${input.event.id}:${p.callId}`;}
   if(p.tool==='memory_stage_delta')args.invocation_id=`${input.event.id}:${input.character.epoch}:${p.callId}`;
   if(p.tool==='agent_approach_player'||p.tool==='agent_turn'){args.invocation_id=`${input.event.id}:${p.callId}`;args.expected_epoch=input.character.epoch;}
   if(p.tool==='minecraft_call'){args.invocation_id=`${input.event.id}:${p.callId}`;args.expected_epoch=input.character.epoch;}
   const result=await client.callTool({name:p.tool,arguments:args},undefined,{timeout:p.tool==='agent_approach_player'?45000:p.tool==='minecraft_call'?30000:p.tool==='minecraft_tools'?20000:p.tool==='minecraft_stop'?10000:p.tool==='telegram_send_group'?45000:p.tool==='telegram_group_participants'?25000:p.tool==='telegram_member_profile'?30000:10000});
   if(p.tool==='telegram_member_profile'){if(!turnId||p.turnId!==turnId)throw new Error('profile_turn_changed');return deliverCodexProfileToolResult(rpc,{threadId:p.threadId,turnId:p.turnId},result);}
   return {success:!result.isError,contentItems:[{type:'inputText',text:JSON.stringify(result)}]};
  };
  const started=await rpc.request('thread/start',{ephemeral:true,environments:[],runtimeWorkspaceRoots:[],cwd,sandbox:'read-only',approvalPolicy:'never',
   model:selected.model,baseInstructions:input.character.persona,
   developerInstructions:isTelegram?renderInstruction('codex-prompt-0.md',[TELEGRAM_INSTRUCTIONS,process.env.TELEGRAM_IMAGES_ENABLED==='true'?IMAGE_INSTRUCTIONS:'',input.memory_instructions??'']):renderInstruction('codex-prompt-1.md',[catalog.some(t=>t.name==='minecraft_call')?MINECRAFT_WORKSPACE_INSTRUCTIONS:readFileSync(new URL('./workspace-unavailable.md',import.meta.url),'utf8'),input.response_instructions??'',input.memory_instructions??'']),
   dynamicTools:[...catalog.map(t=>({type:'function',name:t.name,description:t.description??t.name,inputSchema:t.inputSchema})),
    ...(!isTelegram?[{type:'function',name:'turn_finish',description:toolDescription('codex-finish-this-turn-with-one'),inputSchema:{type:'object',properties:{decision:{type:'string',enum:['reply','silent']},text:{type:'string',minLength:1,maxLength:256},channel:{type:'string',enum:['voice','chat']}},required:['decision'],additionalProperties:false}}]:[])]});
  threadId=started.thread.id;turnId=undefined;
  let telegramReply='';
  let resolveTurn:()=>void=()=>{};let rejectTurn:(e:Error)=>void=()=>{};
  const finished=new Promise<void>((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject;});
  void finished.catch(()=>{}); // A notification may fail the turn before turn/start responds.
  rpc.onNotification=(method,p)=>{
   if(p.threadId!==threadId)return;
   if(method==='item/completed' && p.item.type==='agentMessage' && p.item.phase==='final_answer')telegramReply=p.item.text;
   if(method==='turn/started')turnId=p.turn.id;
   if(method==='turn/completed')p.turn.status==='completed'?resolveTurn():rejectTurn(Object.assign(new Error('codex_turn_failed'),{turn:p.turn}));
  };
  let revoked=false;let checking=false;
  const interrupt=()=>{revoked=true;if(threadId&&turnId)void rpc.request('turn/interrupt',{threadId,turnId}).catch(()=>{});rejectTurn(new Error('turn_revoked'));};
  const deadline=setTimeout(interrupt,90000);
  const fence=setInterval(()=>{
   if(checking)return;checking=true;
   void api('/engine/status').then(s=>{if(s.paused || s.epoch!==input.character.epoch)interrupt();}).catch(interrupt).finally(()=>{checking=false;});
  },1000);
  try{
   const assembledInput=input.turn_input??makeTurnInput(input.event,input.memories,input.recent_conversation??[],input.world_observation,input.social_memory);
   const turn=await rpc.request('turn/start',{threadId,input:[{type:'text',text:JSON.stringify(assembledInput)}],effort:'low',summary:'none',...(isTelegram?{outputSchema:telegramOutputSchema(input.event.author_metadata?.kind==='group')}:{})});
   turnId=turn.turn.id;
   if(revoked || stopped){void rpc.request('turn/interrupt',{threadId,turnId}).catch(()=>{});throw new Error('turn_revoked');}
   await finished;
   if(revoked || stopped || (!isTelegram&&!finishDecision))throw new Error('invalid_or_revoked_turn_decision');
   if(isTelegram) await api('/engine/complete',{event_id:input.event.id,epoch:input.character.epoch,channel:'telegram',...parseTelegramDecision(telegramReply,input.event.author_metadata?.kind==='group')});
   else await api('/engine/complete',finishDecision!.decision==='silent'
    ?{event_id:input.event.id,epoch:input.character.epoch,decision:'silent'}
    :{event_id:input.event.id,epoch:input.character.epoch,decision:'reply',text:finishDecision!.text,channel:finishDecision!.channel});
  }finally{clearTimeout(deadline);clearInterval(fence);rpc.onNotification=()=>{};rpc.onRequest=async()=>{throw new Error('no_active_turn');};}
 }catch(e){
  engineState='degraded';engineErrorCode='engine_turn_failed';void sendHeartbeat().catch(()=>{});
  await handleAttemptFailure(e,{eventId:pendingEventId,
   defer:async event_id=>{await api('/engine/defer',{event_id,epoch:pendingEpoch});},
   sleep,log:entry=>console.error(JSON.stringify(entry)),now:Date.now});
 }
 finally{await client.close();threadId=undefined;turnId=undefined;}
}
rpc.close();
