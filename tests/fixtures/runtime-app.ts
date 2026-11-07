import { buildApp, type BuildAppOptions, type CoreDeps } from '../../apps/core/app.ts';
export const runtimeTokens={owner:'o'.repeat(64),engine:'e'.repeat(64),bridge:'b'.repeat(64),audio:'a'.repeat(64)};
export const runtimePrincipal={characterId:'lada',audienceId:'demo'};
const unused=async()=>{throw new Error('unexpected_dependency');};
export function runtimeApp(options:Pick<BuildAppOptions,'runtime'|'runtimeEngine'|'runtimePolicy'>,overrides:Partial<CoreDeps>={}) {
 const deps:CoreDeps={pool:{query:unused,end:unused},status:async()=>({persona:'Persona'}),search:async()=>[],remember:unused,control:unused,
  ingest:unused,nextEvent:async()=>null,recentConversation:async()=>[],complete:unused,deferEvent:unused,
  enqueueSpeech:unused,claimSpeech:unused,speechState:unused,updateSpeech:unused,
  enqueueClientAction:unused,clientActionStatus:unused,clientActionLease:unused,claimClientAction:unused,
  finishClientAction:unused,saveWorldObservation:unused,latestWorldObservation:unused,cancelClientActions:unused,...overrides};
 return buildApp({principal:runtimePrincipal,tokens:runtimeTokens,deps,allowSystemChatPublicDemo:false,...options});
}
