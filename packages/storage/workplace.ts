import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {Principal} from '../domain/policy.ts';
import {DomainError} from '../domain/policy.ts';
import {fingerprint,secretDetected} from '../runtime/policy.ts';
import type {WorkDecision} from '../runtime/contracts.ts';

/** Fixed owner policy: daytime in Germany, one wake / 2h, <=2 first posts / rolling day. */
export function daytime(at:Date){const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',hourCycle:'h23'}).format(at));return hour>=9&&hour<21;}
export async function deskContext(db:Pick<pg.Pool,'query'>,p:Principal){
 const desk=(await db.query('SELECT revision,notes,plan FROM runtime_desks WHERE character_id=$1 AND audience_id=$2',[p.characterId,p.audienceId])).rows[0]??{revision:1,notes:'',plan:''};
 const a=(await db.query(`SELECT a.revision,b.id,t.observation_gap,t.last_poll_at FROM runtime_autonomy a JOIN telegram_bindings b ON b.id=a.binding_id JOIN telegram_accounts t ON t.bot_id=b.bot_id
 WHERE b.character_id=$1 AND b.audience_id=$2 AND b.enabled AND b.kind='group' AND a.enabled`,[p.characterId,p.audienceId])).rows[0];
 if(!a)return {desk};
 const messages=(await db.query(`SELECT text,incoming,observed_at FROM telegram_messages WHERE binding_id=$1
 ORDER BY seq DESC LIMIT 8`,[a.id])).rows.reverse();
 return {desk,autonomy:{revision:a.revision,posting_allowed:true,observed_at:new Date().toISOString(),
 context:JSON.stringify({observation_gap:a.observation_gap,messages:messages.map(m=>({text:m.text.slice(0,500),incoming:m.incoming,at:new Date(m.observed_at).toISOString()}))})}};
}
// Observation timestamp is not authority. Contents, revisions and scope are bound exactly.
export function deskFingerprint(c:any){return fingerprint({desk:c.desk,autonomy:c.autonomy?{...c.autonomy,observed_at:undefined}:undefined});}
export async function scheduleAutonomy(db:pg.PoolClient,p:Principal,now:Date){
 if(!daytime(now))return;
 const rows=(await db.query(`SELECT a.*,b.audience_id FROM runtime_autonomy a JOIN telegram_bindings b ON b.id=a.binding_id
 JOIN telegram_accounts t ON t.bot_id=b.bot_id WHERE b.character_id=$1 AND b.enabled AND b.kind='group' AND a.enabled
 AND t.status='connected' AND a.next_wake_at<=clock_timestamp() FOR UPDATE OF a`,[p.characterId])).rows;
 for(const a of rows){
  // No catch-up storm after downtime; blocked or waiting work must be resolved, not duplicated.
  await db.query("UPDATE runtime_autonomy SET next_wake_at=clock_timestamp()+interval '2 hours' WHERE binding_id=$1",[a.binding_id]);
  await db.query("UPDATE runtime_activities SET status='failed',version=version+1,updated_at=now() WHERE character_id=$1 AND audience_id=$2 AND origin='self' AND turns_used>=max_turns AND status IN ('ready','waiting_time')",[p.characterId,a.audience_id]);
  if((await db.query("SELECT 1 FROM runtime_activities WHERE character_id=$1 AND audience_id=$2 AND origin='self' AND status NOT IN ('completed','failed','cancelled') LIMIT 1",[p.characterId,a.audience_id])).rowCount)continue;
  if((await db.query("SELECT count(*)::int n FROM runtime_activities WHERE character_id=$1 AND status NOT IN ('completed','failed','cancelled')",[p.characterId])).rows[0].n>=100)continue;
  const id=randomUUID(),key='self:'+randomUUID();
  const objective='Review your scoped desk and group context. Choose worthwhile local work consistent with your persona, maintain notes and plan, or remain silent. Propose a first message only if it adds value. Finish this wake with a truthful summary.';
  await db.query(`INSERT INTO runtime_activities(id,character_id,audience_id,origin,requested_by,invocation_id,create_payload,objective,max_turns)
   VALUES($1,$2,$3,'self','runtime',$4,$5,$6,1)`,[id,p.characterId,a.audience_id,key,JSON.stringify({schedule_revision:a.revision}),objective]);
  await db.query(`INSERT INTO runtime_wakeups(id,character_id,audience_id,activity_id,dedup_key,kind,available_at) VALUES($1,$2,$3,$4,'created','created',$5)`,[randomUUID(),p.characterId,a.audience_id,id,now]);
  await db.query("INSERT INTO runtime_audit(activity_id,version,actor,transition) VALUES($1,1,'runtime','self_wake')",[id]);
 }
}
export async function commitDesk(db:pg.PoolClient,p:Principal,b:WorkDecision,activity:any,approved:boolean,state:any){
 if(activity.origin==='self'&&b.decision.action!=='complete')throw new DomainError('self_wake_must_complete');
 if(!b.desk&&!b.initiative)return;
 if(!approved)throw new DomainError('runtime_approval_invalid');
 const g=(await db.query('SELECT * FROM runtime_model_grants WHERE turn_id=$1',[b.turn_id])).rows[0];
 if(b.desk){
  if(!g?.approved_input?.desk||b.desk.expected_revision!==g.approved_input.desk.revision)throw new DomainError('desk_revision_conflict');
  await db.query('INSERT INTO runtime_desks(character_id,audience_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[p.characterId,p.audienceId]);
  const changed=await db.query(`UPDATE runtime_desks SET notes=$4,plan=$5,revision=revision+1,updated_at=now()
   WHERE character_id=$1 AND audience_id=$2 AND revision=$3`,[p.characterId,p.audienceId,b.desk.expected_revision,b.desk.notes,b.desk.plan]);
  if(!changed.rowCount)throw new DomainError('desk_revision_conflict');
 }
 if(!b.initiative)return;
 if(activity.origin!=='self'||b.decision.action!=='complete'||!g?.approved_input?.autonomy?.posting_allowed||secretDetected(b.initiative))throw new DomainError('initiative_denied');
 const binding=(await db.query(`SELECT b.*,a.revision AS autonomy_revision FROM telegram_bindings b JOIN runtime_autonomy a ON a.binding_id=b.id
 WHERE b.character_id=$1 AND b.audience_id=$2 AND b.kind='group' AND b.enabled AND a.enabled AND a.revision=$3`,[p.characterId,p.audienceId,g.approved_input.autonomy.revision])).rows[0];
 if(!binding||!daytime(new Date(state.db_now)))throw new DomainError('initiative_denied');
 const eid=randomUUID();
 await db.query(`INSERT INTO social_events(id,character_id,audience_id,source_key,author_id,text,author_provenance,author_trust,author_metadata,channel,processed)
 VALUES($1,$2,$3,$4,'runtime:self',$5,'telegram','unverified',$6,'telegram',true)`,[eid,p.characterId,p.audienceId,'runtime:'+b.turn_id,b.initiative.text,JSON.stringify({origin:'self',turn_id:b.turn_id})]);
 await db.query(`INSERT INTO telegram_outbox(id,event_id,binding_id,revision,text,reply_to,direct,state,expires_at,
 runtime_activity_id,runtime_activity_version,runtime_turn_id,runtime_policy_version,runtime_profile_hash,runtime_text_hash,autonomy_revision,autonomy_epoch)
 VALUES($1,$2,$3,$4,$5,NULL,false,'pending',clock_timestamp()+interval '5 minutes',$6,$7,$8,$9,$10,$11,$12,$13)`,
 [randomUUID(),eid,binding.id,binding.revision,b.initiative.text,activity.id,activity.version+1,b.turn_id,g.policy_version,g.profile_hash,fingerprint(b.initiative.text),binding.autonomy_revision,state.epoch]);
}
export async function initiativeDeliveryValid(db:pg.PoolClient,job:any,at=new Date()){
 if(!daytime(at))return false;
 const r=(await db.query(`SELECT 1 FROM runtime_autonomy a JOIN telegram_bindings b ON b.id=a.binding_id JOIN characters c ON c.id=b.character_id
 WHERE b.id=$1 AND b.kind='group' AND b.enabled AND a.enabled AND a.revision=$2 AND c.epoch=$3 AND NOT c.paused
 AND NOT EXISTS(SELECT 1 FROM telegram_messages m WHERE m.binding_id=b.id AND m.incoming AND m.observed_at>clock_timestamp()-interval '10 minutes')
 AND (SELECT count(*) FROM telegram_outbox o WHERE o.binding_id=b.id AND o.autonomy_revision IS NOT NULL AND o.id<>$4 AND o.send_started_at>clock_timestamp()-interval '24 hours')<2
 AND NOT EXISTS(SELECT 1 FROM telegram_outbox o WHERE o.binding_id=b.id AND o.id<>$4 AND o.send_started_at>clock_timestamp()-interval '2 hours')`,[job.binding_id,job.autonomy_revision,job.autonomy_epoch,job.id])).rowCount;
 return !!r;
}

/** Caller must hold the character lock and authenticate the owner. Models cannot call this. */
export async function configureAutonomy(db:pg.PoolClient,characterId:string,bindingId:string,enabled:boolean){
 const b=(await db.query("SELECT * FROM telegram_bindings WHERE id=$1 AND character_id=$2 AND kind='group' AND enabled",[bindingId,characterId])).rows[0];
 if(!b)throw new DomainError('group_binding_required');
 const a=(await db.query(`INSERT INTO runtime_autonomy(binding_id,enabled,next_wake_at) VALUES($1,$2,clock_timestamp()+interval '2 hours')
 ON CONFLICT(binding_id) DO UPDATE SET enabled=$2,revision=runtime_autonomy.revision+1,next_wake_at=clock_timestamp()+interval '2 hours',updated_at=now() RETURNING *`,[bindingId,enabled])).rows[0];
 await db.query("UPDATE telegram_outbox SET state='cancelled' WHERE binding_id=$1 AND autonomy_revision IS NOT NULL AND state IN ('pending','retry_wait')",[bindingId]);
 // Revoke a running inference; pause/epoch fencing preserves recoverable state.
 await db.query('UPDATE characters SET epoch=epoch+1,lease_until=NULL,active_event_id=NULL WHERE id=$1',[characterId]);
 return a;
}
