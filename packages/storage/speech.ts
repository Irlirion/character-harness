import { randomUUID } from 'node:crypto';
import { pool } from './db.ts';
import type { Principal } from '../domain/policy.ts';
import { DomainError } from '../domain/policy.ts';
export async function enqueueSpeech(p: Principal, requestId: string, text: string) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const c=(await db.query('SELECT paused,epoch FROM characters WHERE id=$1 FOR UPDATE',[p.characterId])).rows[0];
    if (!c || c.paused) throw new DomainError('character_paused');
    const old=(await db.query('SELECT id,text,state FROM speech_jobs WHERE character_id=$1 AND audience_id=$2 AND request_id=$3',[p.characterId,p.audienceId,requestId])).rows[0];
    if (old) {
      if (old.text!==text) throw new DomainError('invocation_conflict');
      await db.query('COMMIT'); return {id:old.id,state:old.state};
    }
    const count=await db.query("SELECT count(*)::int AS n FROM speech_jobs WHERE character_id=$1 AND state IN ('pending','claimed','playing') AND expires_at>now()",[p.characterId]);
    if (count.rows[0].n>=3) throw new DomainError('speech_queue_full');
    const id=randomUUID();
    await db.query("INSERT INTO speech_jobs(id,character_id,audience_id,request_id,text,epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '60 seconds')",[id,p.characterId,p.audienceId,requestId,text,c.epoch]);
    await db.query('COMMIT'); return {id,state:'pending'};
  } catch(e) {await db.query('ROLLBACK');throw e;} finally {db.release();}
}
export async function claimSpeech(p: Principal) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const c=(await db.query('SELECT paused,epoch FROM characters WHERE id=$1 FOR UPDATE',[p.characterId])).rows[0];
    await db.query("UPDATE speech_jobs SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE 'unknown' END,finished_at=now() WHERE character_id=$1 AND state IN ('pending','claimed','playing') AND expires_at<=now()",[p.characterId]);
    await db.query("UPDATE speech_jobs SET state='cancelled',finished_at=now() WHERE character_id=$1 AND state IN ('pending','claimed','playing') AND (epoch<>$2 OR $3)",[p.characterId,c.epoch,c.paused]);
    if(c.paused || (await db.query("SELECT 1 FROM speech_jobs WHERE character_id=$1 AND state IN ('claimed','playing')",[p.characterId])).rowCount) {await db.query('COMMIT');return null;}
    const j=(await db.query("SELECT id,text,epoch,expires_at FROM speech_jobs WHERE character_id=$1 AND audience_id=$2 AND state='pending' ORDER BY created_at,id LIMIT 1 FOR UPDATE",[p.characterId,p.audienceId])).rows[0];
    if(j) {
      j.claim_id=randomUUID();
      await db.query("UPDATE speech_jobs SET state='claimed',claim_id=$2,claimed_at=now() WHERE id=$1",[j.id,j.claim_id]);
    }
    await db.query('COMMIT');return j??null;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
export async function speechState(p: Principal,id: string) {
  const r=(await pool.query(`SELECT j.id,j.state,j.epoch,j.expires_at,c.paused,c.epoch AS current_epoch
    FROM speech_jobs j JOIN characters c ON c.id=j.character_id WHERE j.id=$1 AND j.character_id=$2 AND j.audience_id=$3`,[id,p.characterId,p.audienceId])).rows[0];
  if(!r)throw new DomainError('speech_not_found');
  return {...r,allowed: !r.paused && r.epoch===r.current_epoch && new Date(r.expires_at).getTime()>Date.now() && ['claimed','playing'].includes(r.state)};
}
export async function updateSpeech(p: Principal,id:string,claim:string,state:'playing'|'completed'|'failed'|'cancelled') {
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const c=(await db.query('SELECT paused,epoch FROM characters WHERE id=$1 FOR UPDATE',[p.characterId])).rows[0];
    const j=(await db.query('SELECT * FROM speech_jobs WHERE id=$1 AND character_id=$2 AND audience_id=$3 FOR UPDATE',[id,p.characterId,p.audienceId])).rows[0];
    if(!j || j.claim_id!==claim)throw new DomainError('invalid_speech_claim');
    if(!['claimed','playing'].includes(j.state))throw new DomainError('speech_terminal');
    const revoked=c.paused || c.epoch!==j.epoch || new Date(j.expires_at).getTime()<=Date.now();
    const next=revoked?'cancelled':state;
    if(next==='completed' && j.state!=='playing')throw new DomainError('speech_not_playing');
    await db.query("UPDATE speech_jobs SET state=$2,finished_at=CASE WHEN $2='playing' THEN NULL ELSE now() END WHERE id=$1",[id,next]);
    await db.query('COMMIT'); return {state:next};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
