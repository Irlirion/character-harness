import {z} from 'zod';
import type pg from 'pg';
import {DomainError,type Principal} from '../domain/policy.ts';
import type {RuntimeExecutionGate} from './gate.ts';
import {ClaimWorkSchema} from './contracts.ts';

/** Only server-bound private Telegram scopes are added; engine input never chooses an audience. */
export class RuntimeAudienceGate implements RuntimeExecutionGate {
 constructor(privateGate:RuntimeExecutionGate,pool:pg.Pool){this.gate=privateGate;this.pool=pool;}
 private gate:RuntimeExecutionGate;private pool:pg.Pool;private cursor=0;
 private async audiences(p:Principal,includeDisabled=false){const rows=(await this.pool.query("SELECT audience_id FROM telegram_bindings WHERE character_id=$1 AND kind='private' AND ((enabled AND runtime_control) OR $2)",[p.characterId,includeDisabled])).rows;return [...new Set([p.audienceId,...rows.map(r=>r.audience_id)])];}
 async claim(p:Principal,input:unknown){
  const b=ClaimWorkSchema.parse(input),scopes=await this.audiences(p);
  const old=(await this.pool.query('SELECT audience_id FROM runtime_turns WHERE character_id=$1 AND request_id=$2 AND audience_id=ANY($3::text[]) ORDER BY created_at LIMIT 1',[p.characterId,b.request_id,scopes])).rows[0];
  if(old)return this.gate.claim({...p,audienceId:old.audience_id},b);
  let last:{work:any;reason?:string}={work:null,reason:'idle_or_budget_blocked'};
  const start=this.cursor++%scopes.length;
  for(let i=0;i<scopes.length;i++){
   last=await this.gate.claim({...p,audienceId:scopes[(start+i)%scopes.length]},b);
   if(last.work||last.reason!=='idle_or_budget_blocked')return last;
  }
  return last;
 }
 private async scoped(p:Principal,input:unknown,accounting=false){const id=z.object({turn_id:z.uuid()}).parse(input).turn_id,scopes=await this.audiences(p,accounting);const row=(await this.pool.query('SELECT audience_id FROM runtime_turns WHERE id=$1 AND character_id=$2 AND audience_id=ANY($3::text[])',[id,p.characterId,scopes])).rows[0];if(!row)throw new DomainError('runtime_scope_denied');return {...p,audienceId:row.audience_id};}
 async lease(p:Principal,b:unknown){return this.gate.lease(await this.scoped(p,b),b);}
 async start(p:Principal,b:unknown){return this.gate.start(await this.scoped(p,b),b);}
 async decide(p:Principal,b:unknown){return this.gate.decide(await this.scoped(p,b),b);}
 async usage(p:Principal,b:unknown){return this.gate.usage(await this.scoped(p,b,true),b);}
 async overview(p:Principal){return this.gate.overview?.(p);}
 async reviewQueue(p:Principal){return this.gate.reviewQueue?.(p);}
 async retryReview(p:Principal,b:unknown){if(!this.gate.retryReview)throw new DomainError('runtime_policy_blocked');return this.gate.retryReview(p,b);}
 async executionEnabled(p:Principal){return await this.gate.executionEnabled?.(p)??false;}
}
