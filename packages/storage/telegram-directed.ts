import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type pg from 'pg';
import {z} from 'zod';
import {DomainError,type Principal} from '../domain/policy.ts';
import {fingerprint,reviewContent,type ContentReviewer} from '../runtime/policy.ts';
import {currentProfile,profileUsable,writePolicyAudit} from './runtime-authorization.ts';
export class DirectedReviewError extends DomainError {
 readonly rule_id:string;
 constructor(code:string,ruleId:string){super(code);this.rule_id=ruleId;}
}
export function directedErrorDetail(e:DomainError){
 return {error:e.code,...(e instanceof DirectedReviewError?{rule_id:e.rule_id}:{}),
  ...(e.code==='directed_recipient_unclear'?{reason:'Не удалось однозначно понять, кого поздравить или кому адресовать текст. Уточни человека; подключённая группа уже выбрана.'}:{})};
}
export type DirectedReviewer={reviewer:ContentReviewer;timeoutMs:number};

/** Explicit owner delegation from natural language. Recipient is selected by the server. */
export class DirectedTelegram {
 private pool:pg.Pool;private characterId:string;private review?:DirectedReviewer;
 constructor(pool:pg.Pool,characterId:string,review?:DirectedReviewer){this.pool=pool;this.characterId=characterId;this.review=review;}
 private async context(db:Pick<pg.Pool,'query'>,p:Principal,eventId:string,epoch:number){
  if(p.characterId!==this.characterId)throw new DomainError('directed_scope_denied');
  const source=(await db.query(`SELECT e.id,e.text,e.created_at,b.id AS binding_id,b.revision FROM social_events e
   JOIN telegram_decisions d ON d.event_id=e.id JOIN telegram_bindings b ON b.id=d.binding_id
   JOIN characters c ON c.id=e.character_id
   WHERE e.id=$1 AND e.character_id=$2 AND e.audience_id=$3 AND e.channel='telegram' AND NOT e.processed
   AND b.kind='private' AND b.enabled AND b.runtime_control AND e.author_id='telegram:'||b.chat_id
   AND c.epoch=$4 AND c.active_event_id=e.id AND NOT c.paused AND c.lease_until>clock_timestamp()`,[eventId,p.characterId,p.audienceId,epoch])).rows[0];
  if(!source)throw new DomainError('directed_owner_required');
  const targets=(await db.query("SELECT id,revision FROM telegram_bindings WHERE character_id=$1 AND kind='group' AND enabled",[p.characterId])).rows;
  if(targets.length!==1)throw new DomainError('directed_group_unavailable');
  const history=(await db.query(`SELECT e.text,r.text AS reply FROM social_events e LEFT JOIN replies r ON r.event_id=e.id
   WHERE e.character_id=$1 AND e.audience_id=$2 AND e.processed AND (e.created_at,e.id)<($3,$4) ORDER BY e.created_at DESC,e.id DESC LIMIT 4`,[p.characterId,p.audienceId,source.created_at,source.id])).rows;
  // Delivery receipts provide evidence of the ongoing relay, not new authority.
  // Only this owner chat, current source/target revisions and recent confirmed sends qualify.
  const delivered=(await db.query(`SELECT e.text AS owner_request,r.text AS sent_text,o.send_started_at AS sent_at
   FROM telegram_directed_requests r JOIN social_events e ON e.id=r.source_event_id JOIN telegram_outbox o ON o.id=r.outbox_id
   WHERE r.source_binding_id=$1 AND r.source_revision=$2 AND r.target_binding_id=$3 AND r.target_revision=$4
   AND o.state='sent' AND o.send_started_at>clock_timestamp()-interval '30 minutes'
   AND (e.created_at,e.id)<($5,$6) ORDER BY e.created_at DESC,e.id DESC LIMIT 2`,
   [source.binding_id,source.revision,targets[0].id,targets[0].revision,source.created_at,source.id])).rows.reverse();
  return {source,delivered:delivered.map(d=>({owner_request:d.owner_request.slice(0,600),sent_text:d.sent_text,sent_at:new Date(d.sent_at).toISOString()})),history:history.map(h=>({text:h.text.slice(0,1200),reply:h.reply?.slice(0,500)??null})),target:targets[0]};
 }
 async available(p:Principal,eventId:string,epoch:number){
  if(!this.review)return false;
  try{await this.context(this.pool,p,eventId,epoch);const c=await currentProfile(this.pool,p);return !!c&&profileUsable(c.profile,Date.now());}catch(e){if(e instanceof DomainError)return false;throw e;}
 }
 private async receipt(db:Pick<pg.Pool,'query'>,eventId:string,text?:string){
  const r=(await db.query('SELECT r.text,r.outbox_id,o.state FROM telegram_directed_requests r JOIN telegram_outbox o ON o.id=r.outbox_id WHERE r.source_event_id=$1',[eventId])).rows[0];
  if(!r)return null;if(text!==undefined&&r.text!==text)throw new DomainError('directed_message_already_requested');
  return {id:r.outbox_id,state:r.state,target:'configured_group'};
 }
 async send(p:Principal,eventId:string,epoch:number,input:string){
  const text=z.string().trim().min(1).max(1000).parse(input);
  const context=await this.context(this.pool,p,eventId,epoch),old=await this.receipt(this.pool,eventId,text);if(old)return old;
  const current=await currentProfile(this.pool,p);if(!this.review||!current||!profileUsable(current.profile,Date.now()))throw new DomainError('runtime_policy_blocked');
  const payload={operation:'owner_directed_group_message',current_owner_request:context.source.text,recent_private_context:context.history,recent_confirmed_group_deliveries:context.delivered,target:'single_configured_group',text};
  const review=await reviewContent(current.profile,'output',payload,this.review.reviewer,this.review.timeoutMs);
  if(review.verdict!=='allow'){await writePolicyAudit(this.pool,p,null,'output',review);throw new DirectedReviewError(review.verdict==='needs_review'&&/ambiguous|unclear|recipient/.test(review.rule_id)?'directed_recipient_unclear':review.verdict==='needs_review'?'directed_review_unavailable':'directed_content_blocked',review.rule_id);}
  const db=await this.pool.connect();try{
   await db.query('BEGIN');await db.query('SELECT id FROM characters WHERE id=$1 FOR UPDATE',[p.characterId]);
   const fresh=await this.context(db,p,eventId,epoch),profile=await currentProfile(db,p);
   if(fingerprint(fresh)!==fingerprint(context))throw new DomainError('runtime_context_changed');
   if(!profile||profile.profile_hash!==current.profile_hash||!profileUsable(profile.profile,Date.now()))throw new DomainError('runtime_policy_stale');
   const prior=await this.receipt(db,eventId,text);if(prior){await db.query('COMMIT');return prior;}
   const eid=randomUUID(),oid=randomUUID();
   await db.query(`INSERT INTO telegram_directed_requests(source_event_id,source_binding_id,source_revision,target_binding_id,target_revision,policy_version,profile_hash,payload_hash,text,text_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[eventId,context.source.binding_id,context.source.revision,context.target.id,context.target.revision,current.profile.version,current.profile_hash,review.payload_hash,text,fingerprint(text)]);
   // A processed publication record is not a fake incoming group message.
   const targetScope=(await db.query('SELECT audience_id FROM telegram_bindings WHERE id=$1',[context.target.id])).rows[0].audience_id;
   await db.query(`INSERT INTO social_events(id,character_id,audience_id,source_key,author_id,text,author_provenance,author_trust,author_metadata,channel,processed)
    VALUES($1,$2,$3,$4,'runtime:owner-directed',$5,'owner_input','unverified',$6,'telegram',true)`,[eid,p.characterId,targetScope,'directed:'+eventId,text,JSON.stringify({origin:'owner_directed'})]);
   await db.query(`INSERT INTO telegram_outbox(id,event_id,binding_id,revision,text,reply_to,direct,state,expires_at,directed_source_event)
    VALUES($1,$2,$3,$4,$5,NULL,true,'pending',clock_timestamp()+interval '5 minutes',$6)`,[oid,eid,context.target.id,context.target.revision,text,eventId]);
   await db.query('UPDATE telegram_directed_requests SET outbox_id=$2 WHERE source_event_id=$1',[eventId,oid]);
   await writePolicyAudit(db,p,null,'output',review);await db.query('COMMIT');return {id:oid,state:'pending',target:'configured_group'};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async status(p:Principal,eventId:string,epoch:number,id:string){
  z.uuid().parse(id);
  // Status can refer to an earlier request in this same verified owner chat.
  for(let i=0;i<6;i++){
   const context=await this.context(this.pool,p,eventId,epoch);
   const r=(await this.pool.query(`SELECT o.id,o.state FROM telegram_directed_requests r JOIN telegram_outbox o ON o.id=r.outbox_id
    WHERE o.id=$1 AND r.source_binding_id=$2`,[id,context.source.binding_id])).rows[0];
   if(!r)throw new DomainError('directed_delivery_not_found');
   if(!['pending','sending','retry_wait'].includes(r.state)||i===5)return {...r,target:'configured_group'};
   await delay(1000);
  }
  throw new DomainError('directed_delivery_not_found');
 }
}
export async function directedDeliveryValid(db:pg.PoolClient,job:any){
 const r=(await db.query(`SELECT r.*,sb.character_id FROM telegram_directed_requests r
  JOIN telegram_bindings sb ON sb.id=r.source_binding_id JOIN telegram_bindings tb ON tb.id=r.target_binding_id
  WHERE r.source_event_id=$1 AND r.outbox_id=$2 AND sb.enabled AND sb.runtime_control AND sb.kind='private' AND sb.revision=r.source_revision
  AND tb.id=$3 AND tb.enabled AND tb.kind='group' AND tb.revision=r.target_revision AND tb.revision=$4 AND tb.character_id=sb.character_id`,[job.directed_source_event,job.id,job.binding_id,job.revision])).rows[0];
 if(!r||r.text!==job.text||r.text_hash!==fingerprint(job.text))return false;
 const p=await currentProfile(db,{characterId:r.character_id,audienceId:''});return !!p&&p.profile_hash===r.profile_hash&&p.profile.version===r.policy_version&&profileUsable(p.profile,Date.now());
}
