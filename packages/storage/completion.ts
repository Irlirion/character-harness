import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { assertActive, DomainError } from '../domain/policy.ts';
import type { Principal } from '../domain/policy.ts';
import type { SocialMemoryDelta } from '../domain/social-memory.ts';
import { applySocialMemoryDelta, loadStagedSocialMemory, type DeltaResult } from './social-memory.ts';

/** Atomically stores a reply or silence, optional speech, a scoped memory proposal, and event completion. */
export async function completeEvent(connectionPool: pg.Pool, p: Principal, eventId: string, text: string | null, epoch: number, speak = false, delta?: SocialMemoryDelta, deltaDiagnostic?: string, rawDelta?: unknown, decision: 'reply' | 'silent' = 'reply', channel: 'local' | 'voice' | 'chat' = speak ? 'voice' : 'local') {
  const db = await connectionPool.connect();
  try {
    await db.query('BEGIN');
    const state = (await db.query('SELECT paused,epoch,lease_until,active_event_id FROM characters WHERE id=$1 FOR UPDATE', [p.characterId])).rows[0];
    if (!state) throw new DomainError('character_not_found');
    assertActive(state, epoch);
    if((decision==='reply'&&!text)||(decision==='silent'&&(text!==null||speak)))throw new DomainError('invalid_completion_decision');
    if (decision==='reply' && ((channel==='voice')!==speak || (channel==='chat' && (text!.length>256 || /[\r\n\u0000-\u001f\u007f]/.test(text!) || text!.trimStart().startsWith('/'))))) throw new DomainError('invalid_reply_channel');
    const payload = decision==='silent' ? JSON.stringify({decision:'silent',memory_delta:rawDelta??null}) : JSON.stringify({text,speak,...(channel==='chat'?{channel}:{}),memory_delta:rawDelta??null});
    const event = await db.query('SELECT id,processed,completion_payload,completion_memory_result FROM social_events WHERE id=$1 AND character_id=$2 AND audience_id=$3 FOR UPDATE',
      [eventId, p.characterId, p.audienceId]);
    if (!event.rowCount) throw new DomainError('event_not_found');
    if (event.rows[0].processed) {
      const replay = await db.query('SELECT completion_payload=$2::jsonb AS matches FROM social_events WHERE id=$1', [eventId, payload]);
      if (!replay.rows[0].matches) throw new DomainError('completion_conflict');
      await db.query('COMMIT');
      return { saved: true, replayed: true, ...(event.rows[0].completion_payload?.decision==='silent'?{silent:true}:{}), memory: event.rows[0].completion_memory_result ?? undefined };
    }
    if(state.active_event_id!==eventId)throw new DomainError('turn_not_current');
    if (!state.lease_until || new Date(state.lease_until).getTime() <= Date.now()) throw new DomainError('lease_expired');
    if(decision==='reply')await db.query('INSERT INTO replies(event_id,text,channel,epoch) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING', [eventId, text, channel, epoch]);
    if (speak) {
      if (text!.length > 300) throw new DomainError('speech_too_long');
      const active = await db.query("SELECT count(*)::int AS n FROM speech_jobs WHERE character_id=$1 AND state IN ('pending','claimed','playing') AND expires_at>now()", [p.characterId]);
      if (active.rows[0].n >= 3) throw new DomainError('speech_queue_full');
      await db.query(`INSERT INTO speech_jobs(id,character_id,audience_id,request_id,text,epoch,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '60 seconds') ON CONFLICT(character_id,audience_id,request_id) DO NOTHING`,
        [randomUUID(),p.characterId,p.audienceId,`reply:${eventId}`,text,epoch]);
    }
    const staged=await loadStagedSocialMemory(db,p,eventId,epoch);
    if(staged){
      if(delta||deltaDiagnostic){delta=undefined;deltaDiagnostic='multiple_memory_sources';}
      else delta=staged;
    }
    let memory: DeltaResult | undefined = deltaDiagnostic ? { status: 'rejected', reason: deltaDiagnostic } : undefined;
    if (delta) memory = await applySocialMemoryDelta(db, delta, { characterId: p.characterId, audienceId: p.audienceId, eventId, epoch });
    await db.query('DELETE FROM social_memory_staging WHERE character_id=$1 AND audience_id=$2 AND event_id=$3 AND epoch=$4',[p.characterId,p.audienceId,eventId,epoch]);
    await db.query('UPDATE social_events SET processed=true,completion_payload=$2::jsonb,completion_memory_result=$3::jsonb WHERE id=$1', [eventId, payload, memory ? JSON.stringify(memory) : null]);
    await db.query('UPDATE characters SET lease_until=NULL,active_event_id=NULL WHERE id=$1', [p.characterId]);
    await db.query('COMMIT');
    return { saved: true, replayed:false, ...(decision==='silent'?{silent:true}:{}), memory };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
