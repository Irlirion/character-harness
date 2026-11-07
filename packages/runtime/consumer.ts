import { requestFingerprint, type ModelIdentity } from './policy.ts';
import { randomUUID } from 'node:crypto';
import { NextWorkSchema, PlanningDecisionSchema, planningInput, type PlanningDecision, type PlanningInput, type RuntimeWork } from './protocol.ts';

export type RuntimeApi = (path:string,body:unknown)=>Promise<unknown>;
export type PlanningRunner = (input:PlanningInput,persona:string,signal:AbortSignal,onUsage?:(totalTokens:number)=>void)=>Promise<PlanningDecision>;

/** Abort also wins when a provider ignores its cancellation request. */
export async function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  if(signal.aborted){void promise.catch(()=>{});signal.throwIfAborted();}
  let stop:()=>void=()=>{};
  const aborted=new Promise<never>((_resolve,reject)=>{stop=()=>reject(signal.reason??new Error('runtime_turn_revoked'));signal.addEventListener('abort',stop,{once:true});});
  try {return await Promise.race([promise,aborted]);}
  finally {signal.removeEventListener('abort',stop);}
}

export class RuntimeConsumer {
  private requestId=randomUUID();
  private api:RuntimeApi;
  private identity:ModelIdentity;
  constructor(api:RuntimeApi,identity:ModelIdentity){this.api=api;this.identity=identity;}

  async tick(run:PlanningRunner,stop:AbortSignal, timing={fenceMs:1000,maxModelMs:75000}) {
    stop.throwIfAborted();
    // A lost claim response must reuse request_id, not reserve another turn.
    const next=NextWorkSchema.parse(await this.api('/engine/next_work',{request_id:this.requestId,...this.identity}));
    this.requestId=randomUUID();
    if(!next.work)return {worked:false,reason:next.reason};
    await this.execute(next.work,run,stop,timing);
    return {worked:true};
  }

  private async execute(work:RuntimeWork,run:PlanningRunner,stop:AbortSignal,timing:{fenceMs:number;maxModelMs:number}) {
    const approval=work.authorization;
    if(!approval||!work.model_input||approval.engine!==this.identity.engine||approval.model!==this.identity.model||requestFingerprint(work.model_input,work.persona,this.identity)!==approval.input_hash)throw new Error('runtime_approval_invalid');
    const lease={turn_id:work.turn.id,epoch:work.turn.epoch,lease_token:work.turn.lease_token};
    const controller=new AbortController();
    const revoke=()=>controller.abort(new Error('runtime_turn_revoked'));
    stop.addEventListener('abort',revoke,{once:true});
    if(stop.aborted)revoke();
    const valid=async()=>{
      const response=await this.api('/engine/work_lease',lease);
      if(!response || typeof response!=='object' || !('valid' in response) || response.valid!==true)throw new Error('runtime_lease_invalid');
    };
    let checking=false;
    let committing=false;let dispatched=false;let observedTokens:number|null=null;
    let fence:ReturnType<typeof setInterval>|undefined;
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try {
      controller.signal.throwIfAborted();
      await abortable(valid(),controller.signal);
      const remaining=new Date(work.turn.lease_until).getTime()-Date.now()-10000;
      if(remaining<=0)throw new Error('runtime_lease_expired');
      deadline=setTimeout(revoke,Math.min(timing.maxModelMs,approval.max_model_ms,remaining));
      fence=setInterval(()=>{
        if(checking||committing||controller.signal.aborted)return;
        checking=true;
        void valid().catch(revoke).finally(()=>{checking=false;});
      },timing.fenceMs);
      controller.signal.throwIfAborted();
      const start=await this.api('/engine/work_start',{...lease,grant_id:approval.id,input_hash:approval.input_hash,...this.identity});
      if(!start||typeof start!=='object'||!('allowed' in start)||start.allowed!==true)throw new Error('runtime_dispatch_denied');
      dispatched=true;
      controller.signal.throwIfAborted();
      const decision=PlanningDecisionSchema.parse(await abortable(run(planningInput(work),work.persona,controller.signal,total=>{
        if(Number.isSafeInteger(total)&&total>=0)observedTokens=Math.max(observedTokens??0,total);
      }),controller.signal));
      await abortable(valid(),controller.signal);
      controller.signal.throwIfAborted();
      const body={...lease,invocation_id:`runtime:${work.turn.id}`,expected_version:work.activity.version,...decision};
      // Only the exact receipt is retried. Never rerun inference after a lost commit response.
      committing=true;
      clearTimeout(deadline);clearInterval(fence);
      try {await this.api('/engine/work_decision',body);}
      catch {stop.throwIfAborted();await this.api('/engine/work_decision',body);}
    } finally {
      if(deadline)clearTimeout(deadline);
      if(fence)clearInterval(fence);
      stop.removeEventListener('abort',revoke);
      controller.abort(new Error('runtime_turn_closed'));
      if(dispatched)await this.api('/engine/work_usage',{...lease,total_tokens:observedTokens,source:this.identity.engine==='pi'?'pi_session':'codex_notification'}).catch(()=>{});
    }
  }
}
