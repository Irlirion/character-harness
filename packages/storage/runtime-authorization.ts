import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Principal } from '../domain/policy.ts';
import { DomainError } from '../domain/policy.ts';
import { RuntimeProfileSchema, fingerprint, type ApprovedClaim, type ApprovedDecision, type RuntimeProfile, type ReviewResult } from '../runtime/policy.ts';

export async function currentProfile(db:Pick<pg.Pool,'query'>|pg.PoolClient,p:Principal) {
 const row=(await db.query(`SELECT p.bundle,p.profile_hash FROM runtime_policy_current c JOIN runtime_policy_profiles p
  ON p.character_id=c.character_id AND p.version=c.version WHERE c.character_id=$1`,[p.characterId])).rows[0];
 if(!row)return null;
 const profile=RuntimeProfileSchema.parse(row.bundle);
 if(row.profile_hash!==fingerprint(profile))throw new DomainError('policy_integrity_error');
 return {profile,profile_hash:row.profile_hash as string};
}
export function profileUsable(profile:RuntimeProfile,now:number) {return profile.enabled&&profile.provider_eligible&&Date.parse(profile.reviewed_at)<=now&&Date.parse(profile.expires_at)>now;}
export async function assertCurrentProfile(db:pg.PoolClient,p:Principal,version:string,hash:string) {
 const current=await currentProfile(db,p);
 const now=(await db.query('SELECT clock_timestamp() AS at')).rows[0].at.getTime();
 if(!current||current.profile.version!==version||current.profile_hash!==hash||!profileUsable(current.profile,now))throw new DomainError('runtime_policy_stale');
 return current.profile;
}
export async function resourceBudget(db:Pick<pg.Pool,'query'>|pg.PoolClient,p:Principal,profile:RuntimeProfile) {
 const r=(await db.query(`SELECT count(*)::int AS dispatches,coalesce(sum(greatest(reserved_tokens,coalesce(observed_tokens,0))),0)::bigint AS tokens
  FROM runtime_model_grants WHERE character_id=$1 AND created_at>clock_timestamp()-interval '24 hours'`,[p.characterId])).rows[0];
 return {dispatches:r.dispatches as number,tokens:Number(r.tokens),allowed:r.dispatches<profile.max_dispatches_24h&&Number(r.tokens)+profile.reserved_tokens<=profile.token_budget_24h};
}
export async function reserveModelGrant(db:pg.PoolClient,p:Principal,turn:any,approved:ApprovedClaim) {
 const profile=await assertCurrentProfile(db,p,approved.profile.version,approved.profile_hash);
 if(!(await resourceBudget(db,p,profile)).allowed)throw new DomainError('runtime_resource_budget');
 const id=randomUUID();
 await db.query(`INSERT INTO runtime_model_grants(id,turn_id,activity_id,character_id,audience_id,policy_version,profile_hash,source_hash,input_hash,approved_input,persona,engine,model,expires_at,reserved_tokens,max_model_ms)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,least($14::timestamptz,$15::timestamptz),$16,$17)`,
  [id,turn.id,turn.activity_id,p.characterId,p.audienceId,profile.version,approved.profile_hash,approved.source_hash,approved.input_hash,JSON.stringify(approved.input),approved.persona,profile.engine,profile.model,turn.lease_until,profile.expires_at,profile.reserved_tokens,profile.max_model_ms]);
 await writePolicyAudit(db,p,turn.id,'input',approved.review);
}
export async function writePolicyAudit(db:Pick<pg.Pool,'query'>|pg.PoolClient,p:Principal,turnId:string|null,phase:'input'|'output'|'dispatch',review:ReviewResult) {
 await db.query(`INSERT INTO runtime_policy_audit(character_id,audience_id,turn_id,policy_version,phase,payload_hash,verdict,rule_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [p.characterId,p.audienceId,turnId,review.policy_version,phase,review.payload_hash,review.verdict,review.rule_id]);
}
export async function assertDecisionGrant(db:pg.PoolClient,p:Principal,turn:any,body:unknown,approved:ApprovedDecision,replay:boolean) {
 await assertCurrentProfile(db,p,approved.profile_version,approved.profile_hash);
 const g=(await db.query(`SELECT * FROM runtime_model_grants WHERE id=$1 AND turn_id=$2 AND character_id=$3 AND audience_id=$4 FOR UPDATE`,[approved.grant_id,turn.id,p.characterId,p.audienceId])).rows[0];
 if(!g||g.policy_version!==approved.profile_version||g.profile_hash!==approved.profile_hash||fingerprint(body)!==approved.output_hash||approved.review.verdict!=='allow'||approved.review.payload_hash!==fingerprint({checkpoint:(body as any).checkpoint,decision:(body as any).decision}))throw new DomainError('runtime_approval_invalid');
 if(replay){if(g.state!=='finished'||g.output_hash!==approved.output_hash)throw new DomainError('runtime_approval_invalid');return;}
 const now=(await db.query('SELECT clock_timestamp() AS at')).rows[0].at.getTime();
 if(g.state!=='started'||new Date(g.expires_at).getTime()<=now)throw new DomainError('runtime_approval_expired');
 await db.query("UPDATE runtime_model_grants SET state='finished',output_hash=$2 WHERE id=$1",[g.id,approved.output_hash]);
 await writePolicyAudit(db,p,turn.id,'output',approved.review);
}

export class RuntimeAuthorizationStore {
 private pool:pg.Pool;
 constructor(pool:pg.Pool){this.pool=pool;}
 async reserveReview(p:Principal,maxRequests:number,signal:AbortSignal,binding?:{policy_version:string;rules_hash:string}) {
  const db=await this.pool.connect();try{
   await db.query('BEGIN');await db.query('SELECT id FROM characters WHERE id=$1 FOR UPDATE',[p.characterId]);
   signal.throwIfAborted();
   if(binding){
    const current=await currentProfile(db,p);
    if(!current||current.profile.version!==binding.policy_version||!profileUsable(current.profile,Date.now()))throw new DomainError('reviewer_policy_stale');
    await db.query('INSERT INTO runtime_reviewer_bindings(character_id,policy_version,rules_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[p.characterId,binding.policy_version,binding.rules_hash]);
    const known=(await db.query('SELECT rules_hash FROM runtime_reviewer_bindings WHERE character_id=$1 AND policy_version=$2',[p.characterId,binding.policy_version])).rows[0];
    if(known.rules_hash!==binding.rules_hash)throw new DomainError('reviewer_rules_conflict');
   }
   const n=(await db.query("SELECT count(*)::int AS n FROM runtime_review_dispatches WHERE character_id=$1 AND created_at>clock_timestamp()-interval '24 hours'",[p.characterId])).rows[0].n;
   if(n>=maxRequests){await db.query('ROLLBACK');return false;}
   await db.query('INSERT INTO runtime_review_dispatches(id,character_id,audience_id) VALUES($1,$2,$3)',[randomUUID(),p.characterId,p.audienceId]);
   await db.query('COMMIT');return true;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async reviewQueue(p:Principal) {
  return (await this.pool.query(`SELECT h.activity_id,h.activity_version,h.policy_version,h.payload_hash,h.verdict,h.rule_id,h.created_at
   FROM runtime_policy_holds h JOIN runtime_activities a ON a.id=h.activity_id AND a.version=h.activity_version
   JOIN runtime_policy_current c ON c.character_id=h.character_id AND c.version=h.policy_version
   WHERE h.character_id=$1 AND h.audience_id=$2 ORDER BY h.created_at DESC LIMIT 100`,[p.characterId,p.audienceId])).rows;
 }
 /** A retry never approves content. Hard denials cannot be released by this API. */
 async retryReview(p:Principal,b:{request_id:string;activity_id:string;activity_version:number;policy_version:string;payload_hash:string}) {
  const db=await this.pool.connect();try{
   await db.query('BEGIN');await db.query('SELECT id FROM characters WHERE id=$1 FOR UPDATE',[p.characterId]);
   const old=(await db.query('SELECT * FROM runtime_review_retries WHERE character_id=$1 AND audience_id=$2 AND request_id=$3',[p.characterId,p.audienceId,b.request_id])).rows[0];
   if(old){
    if(old.activity_id!==b.activity_id||old.activity_version!==b.activity_version||old.policy_version!==b.policy_version||old.payload_hash!==b.payload_hash)throw new DomainError('review_retry_conflict');
    await db.query('COMMIT');return {queued:true};
   }
   const h=(await db.query(`SELECT h.* FROM runtime_policy_holds h JOIN runtime_activities a ON a.id=h.activity_id AND a.version=h.activity_version
    JOIN runtime_policy_current c ON c.character_id=h.character_id AND c.version=h.policy_version
    WHERE h.activity_id=$1 AND h.character_id=$2 AND h.audience_id=$3 FOR UPDATE OF h`,[b.activity_id,p.characterId,p.audienceId])).rows[0];
   if(!h||h.activity_version!==b.activity_version||h.policy_version!==b.policy_version||h.payload_hash!==b.payload_hash)throw new DomainError('review_retry_stale');
   if(h.verdict!=='needs_review')throw new DomainError('review_denial_final');
   const limits=(await db.query(`SELECT count(*)::int AS n,coalesce(max(created_at)>clock_timestamp()-interval '1 minute',false) AS cooling
    FROM runtime_review_retries WHERE character_id=$1 AND audience_id=$2 AND activity_id=$3 AND activity_version=$4 AND policy_version=$5`,
    [p.characterId,p.audienceId,b.activity_id,b.activity_version,b.policy_version])).rows[0];
   if(limits.n>=3||limits.cooling)throw new DomainError('review_retry_limit');
   await db.query(`INSERT INTO runtime_review_retries(character_id,audience_id,request_id,activity_id,activity_version,policy_version,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [p.characterId,p.audienceId,b.request_id,b.activity_id,b.activity_version,b.policy_version,b.payload_hash]);
   await db.query('DELETE FROM runtime_policy_holds WHERE activity_id=$1',[b.activity_id]);
   await writePolicyAudit(db,p,null,'input',{verdict:'needs_review',rule_id:'operator_retry',policy_version:b.policy_version,payload_hash:b.payload_hash});
   await db.query('COMMIT');return {queued:true};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async profile(p:Principal){return currentProfile(this.pool,p);}
 async budget(p:Principal,profile:RuntimeProfile){return resourceBudget(this.pool,p,profile);}
 /** Operator-only composition API; no HTTP/tool route can install or change a policy. */
 async installProfile(p:Principal,input:unknown) {
  const profile=RuntimeProfileSchema.parse(input);const hash=fingerprint(profile);const db=await this.pool.connect();
  try{
   await db.query('BEGIN');await db.query('SELECT id FROM characters WHERE id=$1 FOR UPDATE',[p.characterId]);
   const old=(await db.query('SELECT profile_hash FROM runtime_policy_profiles WHERE character_id=$1 AND version=$2',[p.characterId,profile.version])).rows[0];
   if(old&&old.profile_hash!==hash)throw new DomainError('policy_version_conflict');
   await db.query('INSERT INTO runtime_policy_profiles(character_id,version,profile_hash,bundle) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[p.characterId,profile.version,hash,JSON.stringify(profile)]);
   await db.query('INSERT INTO runtime_policy_current(character_id,version) VALUES($1,$2) ON CONFLICT(character_id) DO UPDATE SET version=excluded.version',[p.characterId,profile.version]);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async hold(p:Principal,a:any,profile:RuntimeProfile,review:ReviewResult) {
  const db=await this.pool.connect();try{
   await db.query('BEGIN');await db.query('SELECT id FROM characters WHERE id=$1 FOR UPDATE',[p.characterId]);
   const row=(await db.query('SELECT version FROM runtime_activities WHERE id=$1 AND character_id=$2 AND audience_id=$3',[a.id,p.characterId,p.audienceId])).rows[0];
   if(row?.version===a.version){
    await db.query(`INSERT INTO runtime_policy_holds(activity_id,character_id,audience_id,activity_version,policy_version,payload_hash,verdict,rule_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(activity_id) DO UPDATE SET activity_version=excluded.activity_version,policy_version=excluded.policy_version,payload_hash=excluded.payload_hash,verdict=excluded.verdict,rule_id=excluded.rule_id,created_at=now()`,
     [a.id,p.characterId,p.audienceId,a.version,profile.version,review.payload_hash,review.verdict,review.rule_id]);
    await writePolicyAudit(db,p,null,'input',review);
   }
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async overview(p:Principal) {
  const current=await this.profile(p);
  const grants=(await this.pool.query(`SELECT turn_id,policy_version,engine,model,state,reserved_tokens,observed_tokens,usage_source,created_at,started_at,expires_at
   FROM runtime_model_grants WHERE character_id=$1 AND audience_id=$2 ORDER BY created_at DESC LIMIT 20`,[p.characterId,p.audienceId])).rows;
  return {profile:current?{version:current.profile.version,enabled:current.profile.enabled,provider_eligible:current.profile.provider_eligible,
   reviewed_at:current.profile.reviewed_at,expires_at:current.profile.expires_at,engine:current.profile.engine,model:current.profile.model}:null,
   resources:current?await this.budget(p,current.profile):null,grants};
 }
 async replay(p:Principal,requestId:string) {
  return (await this.pool.query(`SELECT g.turn_id FROM runtime_model_grants g JOIN runtime_turns t ON t.id=g.turn_id WHERE t.character_id=$1 AND t.audience_id=$2 AND t.request_id=$3`,[p.characterId,p.audienceId,requestId])).rows[0]??null;
 }
 async grant(p:Principal,turnId:string) {
  return (await this.pool.query('SELECT * FROM runtime_model_grants WHERE turn_id=$1 AND character_id=$2 AND audience_id=$3',[turnId,p.characterId,p.audienceId])).rows[0]??null;
 }
 async decisionGrant(p:Principal,b:{turn_id:string;epoch:number;lease_token:string}) {
  return (await this.pool.query(`SELECT g.* FROM runtime_model_grants g JOIN runtime_turns t ON t.id=g.turn_id JOIN characters c ON c.id=g.character_id
   WHERE g.turn_id=$1 AND g.character_id=$2 AND g.audience_id=$3 AND t.epoch=$4 AND t.lease_token=$5 AND c.epoch=$4 AND NOT c.paused`,[b.turn_id,p.characterId,p.audienceId,b.epoch,b.lease_token])).rows[0]??null;
 }
 async grantValid(p:Principal,turnId:string) {
  const g=await this.grant(p,turnId);const c=await this.profile(p);
  const now=(await this.pool.query('SELECT clock_timestamp() AS at')).rows[0].at.getTime();
  return !!g&&!!c&&c.profile.version===g.policy_version&&c.profile_hash===g.profile_hash&&profileUsable(c.profile,now)&&['authorized','started'].includes(g.state)&&new Date(g.expires_at).getTime()>now;
 }
 async start(p:Principal,b:{turn_id:string;epoch:number;lease_token:string;grant_id:string;input_hash:string;engine:string;model:string}) {
  const db=await this.pool.connect();try{
   await db.query('BEGIN');
   const c=(await db.query('SELECT * FROM characters WHERE id=$1 FOR UPDATE',[p.characterId])).rows[0];
   const g=(await db.query(`SELECT g.*,t.epoch,t.lease_token,t.status AS turn_status,t.lease_until AS turn_lease_until FROM runtime_model_grants g JOIN runtime_turns t ON t.id=g.turn_id WHERE g.id=$1 AND g.turn_id=$2 AND g.character_id=$3 AND g.audience_id=$4 FOR UPDATE OF g`,[b.grant_id,b.turn_id,p.characterId,p.audienceId])).rows[0];
   if(!g||!c||c.paused||c.epoch!==b.epoch||c.active_runtime_turn_id!==b.turn_id||g.epoch!==b.epoch||g.lease_token!==b.lease_token||g.input_hash!==b.input_hash||g.engine!==b.engine||g.model!==b.model)throw new DomainError('runtime_approval_invalid');
   await assertCurrentProfile(db,p,g.policy_version,g.profile_hash);
   const now=(await db.query('SELECT clock_timestamp() AS at')).rows[0].at.getTime();
   if(g.state!=='authorized'||g.turn_status!=='running'||c.active_event_id||new Date(g.turn_lease_until).getTime()<=now||new Date(g.expires_at).getTime()<=now||!c.lease_until||new Date(c.lease_until).getTime()<=now)throw new DomainError('runtime_dispatch_denied');
   await db.query("UPDATE runtime_model_grants SET state='started',started_at=clock_timestamp(),expires_at=least(expires_at,clock_timestamp()+max_model_ms*interval '1 millisecond') WHERE id=$1",[g.id]);
   await writePolicyAudit(db,p,g.turn_id,'dispatch',{verdict:'allow',rule_id:'single_start_permit',policy_version:g.policy_version,payload_hash:g.input_hash});
   await db.query('COMMIT');return {allowed:true};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async usage(p:Principal,b:{turn_id:string;epoch:number;lease_token:string;total_tokens:number|null;source:'pi_session'|'codex_notification'}) {
  const r=await this.pool.query(`UPDATE runtime_model_grants g SET observed_tokens=CASE WHEN $6::bigint IS NULL THEN g.observed_tokens ELSE greatest(coalesce(g.observed_tokens,0),$6) END,usage_source=$7
   FROM runtime_turns t WHERE g.turn_id=t.id AND t.id=$1 AND g.character_id=$2 AND g.audience_id=$3 AND t.epoch=$4 AND t.lease_token=$5
   AND g.state IN ('started','finished','blocked') AND (($7='pi_session' AND g.engine='pi') OR ($7='codex_notification' AND g.engine='codex')) RETURNING g.id`,
   [b.turn_id,p.characterId,p.audienceId,b.epoch,b.lease_token,b.total_tokens,b.source]);
  if(!r.rowCount)throw new DomainError('runtime_usage_invalid');return {saved:true};
 }
 async outputDenied(p:Principal,turnId:string,review:ReviewResult) {
  const db=await this.pool.connect();try{
   await db.query('BEGIN');await db.query('SELECT id FROM characters WHERE id=$1 FOR UPDATE',[p.characterId]);
   const a=(await db.query(`SELECT a.* FROM runtime_model_grants g JOIN runtime_activities a ON a.id=g.activity_id
    WHERE g.turn_id=$1 AND g.character_id=$2 AND g.audience_id=$3 AND g.state='started'`,[turnId,p.characterId,p.audienceId])).rows[0];
   if(a){
    await writePolicyAudit(db,p,turnId,'output',review);
    await db.query("UPDATE runtime_model_grants SET state='blocked' WHERE turn_id=$1",[turnId]);
    await db.query(`INSERT INTO runtime_policy_holds(activity_id,character_id,audience_id,activity_version,policy_version,payload_hash,verdict,rule_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(activity_id) DO UPDATE SET activity_version=excluded.activity_version,policy_version=excluded.policy_version,payload_hash=excluded.payload_hash,verdict=excluded.verdict,rule_id=excluded.rule_id`,
     [a.id,p.characterId,p.audienceId,a.version+(a.status==='running'?1:0),review.policy_version,review.payload_hash,review.verdict,review.rule_id]);
   }
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
}
