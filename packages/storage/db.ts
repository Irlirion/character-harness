import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { assertActive, assertReplay, DomainError } from '../domain/policy.ts';
import type { Principal } from '../domain/policy.ts';
import { secret } from '../domain/secrets.ts';
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
  const { rows } = await pool.query('UPDATE characters SET paused=$2, epoch=epoch+1, lease_until=NULL WHERE id=$1 RETURNING paused,epoch', [p.characterId, paused]);
  if (!rows[0]) throw new DomainError('character_not_found');
  return rows[0];
}
export async function ingest(p: Principal, event: { source_key: string; author_id: string; text: string; reply_to?: string; author_provenance: string; author_trust: 'unverified' }) {
  const { rows } = await pool.query(`INSERT INTO social_events(id,character_id,audience_id,source_key,author_id,text,reply_to,author_provenance,author_trust)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(character_id,audience_id,source_key) DO NOTHING RETURNING id`,
    [randomUUID(), p.characterId, p.audienceId, event.source_key, event.author_id, event.text, event.reply_to ?? null, event.author_provenance, event.author_trust]);
  return { inserted: rows.length === 1, event_id: rows[0]?.id ?? null };
}
export async function nextEvent(p: Principal) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const state = (await db.query('SELECT paused,lease_until FROM characters WHERE id=$1 FOR UPDATE', [p.characterId])).rows[0];
    if (!state || state.paused || (state.lease_until && new Date(state.lease_until).getTime() > Date.now())) {
      await db.query('COMMIT'); return null;
    }
    const event = (await db.query(`SELECT id,author_id,author_provenance,author_trust,text,reply_to FROM social_events
      WHERE character_id=$1 AND audience_id=$2 AND NOT processed AND attempts<3 ORDER BY created_at,id LIMIT 1`,
      [p.characterId,p.audienceId])).rows[0];
    if (event) {
      await db.query('UPDATE social_events SET attempts=attempts+1 WHERE id=$1', [event.id]);
      await db.query("UPDATE characters SET epoch=epoch+1,lease_until=now()+interval '2 minutes' WHERE id=$1", [p.characterId]);
    }
    await db.query('COMMIT'); return event ?? null;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
export async function complete(p: Principal, eventId: string, text: string, epoch: number, speak = false) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const state = (await db.query('SELECT paused,epoch,lease_until FROM characters WHERE id=$1 FOR UPDATE', [p.characterId])).rows[0];
    if (!state) throw new DomainError('character_not_found');
    assertActive(state, epoch);
    if (!state.lease_until || new Date(state.lease_until).getTime() <= Date.now()) throw new DomainError('lease_expired');
    const event = await db.query('SELECT id FROM social_events WHERE id=$1 AND character_id=$2 AND audience_id=$3 FOR UPDATE',
      [eventId, p.characterId, p.audienceId]);
    if (!event.rowCount) throw new DomainError('event_not_found');
    await db.query('INSERT INTO replies(event_id,text) VALUES($1,$2) ON CONFLICT(event_id) DO NOTHING', [eventId, text]);
    if (speak) {
      if (text.length > 300) throw new DomainError('speech_too_long');
      const active = await db.query("SELECT count(*)::int AS n FROM speech_jobs WHERE character_id=$1 AND state IN ('pending','claimed','playing') AND expires_at>now()", [p.characterId]);
      if (active.rows[0].n >= 3) throw new DomainError('speech_queue_full');
      await db.query(`INSERT INTO speech_jobs(id,character_id,audience_id,request_id,text,epoch,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '60 seconds') ON CONFLICT(character_id,audience_id,request_id) DO NOTHING`,
        [randomUUID(),p.characterId,p.audienceId,`reply:${eventId}`,text,epoch]);
    }
    await db.query('UPDATE social_events SET processed=true WHERE id=$1', [eventId]);
    await db.query('UPDATE characters SET lease_until=NULL WHERE id=$1', [p.characterId]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
