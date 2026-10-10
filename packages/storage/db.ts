import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { assertActive, assertReplay, DomainError } from '../domain/policy.ts';
import type { Principal } from '../domain/policy.ts';
import { secret } from '../domain/secrets.ts';
import { loadRecentConversation } from './conversation.ts';
import { ingestEvent, type SocialEvent } from './events.ts';
import { completeEvent } from './completion.ts';
import { loadSocialContext as readSocialContext, stageSocialMemory as stageProposal, listSocialCommitments as listCommitments, type DeltaResult, loadStagedSocialMemory } from './social-memory.ts';
import type { SocialMemoryProposal } from '../domain/social-memory.ts';
import type { SocialMemoryDelta } from '../domain/social-memory.ts';
export const pool = new pg.Pool({ connectionString: secret('DATABASE_URL'), max: 8 });
export async function status(p: Principal) {
  const { rows } = await pool.query('SELECT id, name, persona, paused, epoch FROM characters WHERE id=$1', [p.characterId]);
  if (!rows[0]) throw new DomainError('character_not_found');
  return rows[0];
}
export async function search(p: Principal, query: string) {
  const { rows } = await pool.query(`SELECT id, text, source, created_at FROM memories
    WHERE character_id=$1 AND audience_id=$2 AND ($3='' OR strpos(lower(text),lower($3))>0)
    ORDER BY created_at DESC LIMIT 20`, [p.characterId, p.audienceId, query]);
  return rows;
}
// One transaction locks character state, fences stale calls and commits the effect + replay record.
export async function remember(p: Principal, text: string, invocationId: string, epoch: number) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query('SELECT paused,epoch,lease_until FROM characters WHERE id=$1 FOR UPDATE', [p.characterId]);
    if (!rows[0]) throw new DomainError('character_not_found');
    assertActive(rows[0], epoch);
    if (!rows[0].lease_until || new Date(rows[0].lease_until).getTime() <= Date.now()) throw new DomainError('lease_expired');
    const payload = JSON.stringify({ text });
    const old = await db.query(`SELECT payload,result FROM operations WHERE character_id=$1 AND audience_id=$2 AND invocation_id=$3`,
      [p.characterId, p.audienceId, invocationId]);
    if (old.rows[0]) {
      assertReplay(old.rows[0].payload, payload);
      await db.query('COMMIT');
      return old.rows[0].result;
    }
    const memoryId = randomUUID();
    const operationId = randomUUID();
    await db.query('INSERT INTO memories(id,character_id,audience_id,text,source) VALUES($1,$2,$3,$4,$5)',
      [memoryId, p.characterId, p.audienceId, text, 'agent_proposal']);
    const result = { operation_id: operationId, status: 'succeeded', memory_id: memoryId, verified: false };
    await db.query(`INSERT INTO operations(id,character_id,audience_id,invocation_id,payload,status,result)
      VALUES($1,$2,$3,$4,$5,'succeeded',$6)`, [operationId, p.characterId, p.audienceId, invocationId, payload, result]);
    await db.query('COMMIT');
    return result;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
export async function control(p: Principal, paused: boolean) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const current=(await db.query('SELECT id,active_event_id FROM characters WHERE id=$1 FOR UPDATE',[p.characterId])).rows[0];
    if(!current)throw new DomainError('character_not_found');
    const rows=(await db.query('UPDATE characters SET paused=$2, epoch=epoch+1, lease_until=NULL,active_event_id=NULL WHERE id=$1 RETURNING paused,epoch',[p.characterId,paused])).rows;
    if(current.active_event_id)await db.query('DELETE FROM social_memory_staging WHERE event_id=$1',[current.active_event_id]);
    await db.query('COMMIT');return rows[0];
  } catch(error){await db.query('ROLLBACK');throw error;} finally{db.release();}
}
export async function ingest(p: Principal, event: SocialEvent) {
  return ingestEvent(pool, p, event);
}
export async function nextEvent(p: Principal) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const state = (await db.query('SELECT paused,lease_until,active_event_id FROM characters WHERE id=$1 FOR UPDATE', [p.characterId])).rows[0];
    if (!state || state.paused || (state.lease_until && new Date(state.lease_until).getTime() > Date.now())) {
      await db.query('COMMIT'); return null;
    }
    if(state.active_event_id)await db.query('DELETE FROM social_memory_staging WHERE character_id=$1 AND audience_id=$2 AND event_id=$3',[p.characterId,p.audienceId,state.active_event_id]);
    const event = (await db.query(`SELECT id,author_id,author_provenance,author_trust,author_metadata,text,reply_to,source_key FROM social_events
      WHERE character_id=$1 AND audience_id=$2 AND NOT processed AND attempts<3 ORDER BY created_at,id LIMIT 1`,
      [p.characterId,p.audienceId])).rows[0];
    if (event) {
      await db.query('UPDATE social_events SET attempts=attempts+1 WHERE id=$1', [event.id]);
      const claimed=(await db.query("UPDATE characters SET epoch=epoch+1,lease_until=now()+interval '2 minutes',active_event_id=$2 WHERE id=$1 RETURNING epoch", [p.characterId,event.id])).rows[0];
      await db.query('DELETE FROM social_memory_staging WHERE event_id=$1 AND epoch<>$2',[event.id,claimed.epoch]);
    }
    await db.query('COMMIT'); return event ?? null;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
export async function recentConversation(p: Principal, currentEventId: string) {
  return loadRecentConversation(pool.query.bind(pool), p, currentEventId);
}
export async function loadSocialContext(p:Principal,event:any){return readSocialContext(pool,p,event);}
export async function inspectEvent(p:Principal,eventId?:string){
  const result=eventId
    ?await pool.query(`SELECT id,author_id,author_provenance,author_trust,author_metadata,text,reply_to,source_key FROM social_events
      WHERE id=$1 AND character_id=$2 AND audience_id=$3 AND NOT processed`,[eventId,p.characterId,p.audienceId])
    :await pool.query(`SELECT id,author_id,author_provenance,author_trust,author_metadata,text,reply_to,source_key FROM social_events
      WHERE character_id=$1 AND audience_id=$2 AND NOT processed ORDER BY created_at,id LIMIT 1`,[p.characterId,p.audienceId]);
  if(eventId&&!result.rowCount)throw new DomainError('event_not_found');
  return result.rows[0]??null;
}
export async function stageMemory(p:Principal,eventId:string,epoch:number,invocationId:string,proposal:unknown){
  return stageProposal(pool,p,eventId,epoch,invocationId,proposal);
}
export async function socialCommitmentPage(p:Principal,eventId:string,epoch:number,limit:number,offset:number){
  const state=(await pool.query('SELECT epoch,active_event_id,paused,lease_until FROM characters WHERE id=$1',[p.characterId])).rows[0];
  if(!state||state.paused||Number(state.epoch)!==epoch||state.active_event_id!==eventId||!state.lease_until||new Date(state.lease_until).getTime()<=Date.now())throw new DomainError('turn_not_current');
  const event=(await pool.query(`SELECT author_id,source_key FROM social_events WHERE id=$1 AND character_id=$2 AND audience_id=$3 AND NOT processed`,[eventId,p.characterId,p.audienceId])).rows[0];
  if(!event)throw new DomainError('event_not_found');
  return listCommitments(pool,p,event,limit,offset);
}
/** Hand an event back untouched: a quota pause is not a failure, so the budget is restored. */
export async function deferEvent(p: Principal, eventId: string, epoch?: number) {
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const state=(await db.query('SELECT epoch,active_event_id,lease_until FROM characters WHERE id=$1 FOR UPDATE',[p.characterId])).rows[0];
    if(!state)throw new DomainError('character_not_found');
    if(epoch===undefined){
      if(state.active_event_id!==null && state.lease_until && new Date(state.lease_until).getTime()>Date.now())throw new DomainError('epoch_required');
    }else if(Number(state.epoch)!==epoch || state.active_event_id!==eventId)throw new DomainError('stale_epoch');
    const updated=await db.query(`UPDATE social_events SET attempts=0 WHERE id=$1 AND character_id=$2 AND audience_id=$3 AND NOT processed`,[eventId,p.characterId,p.audienceId]);
    if(!updated.rowCount)throw new DomainError('event_not_found');
    if(state.active_event_id===eventId){
      await db.query('UPDATE characters SET lease_until=NULL,active_event_id=NULL WHERE id=$1',[p.characterId]);
      await db.query('DELETE FROM social_memory_staging WHERE event_id=$1',[eventId]);
    }
    await db.query('COMMIT');return {deferred:true};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function complete(p: Principal, eventId: string, text: string | null, epoch: number, speak = false, delta?: SocialMemoryDelta, deltaDiagnostic?: string, rawDelta?: unknown, decision:'reply'|'silent'='reply') {
  return completeEvent(pool, p, eventId, text, epoch, speak, delta, deltaDiagnostic, rawDelta, decision);
}
