import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Principal } from '../domain/policy.ts';
import { DomainError } from '../domain/policy.ts';

export type SocialEvent = { source_key: string; author_id: string; text: string; reply_to?: string; author_provenance: string; author_trust: 'unverified' };

/** Serialize admissions with the same character lock used by claim/complete. */
export async function ingestEvent(pool: pg.Pool, p: Principal, event: SocialEvent) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const character = await db.query('SELECT id FROM characters WHERE id=$1 FOR UPDATE', [p.characterId]);
    if (!character.rowCount) throw new DomainError('character_not_found');
    const old = await db.query('SELECT id FROM social_events WHERE character_id=$1 AND audience_id=$2 AND source_key=$3',
      [p.characterId, p.audienceId, event.source_key]);
    if (old.rowCount) {
      await db.query('COMMIT');
      return { inserted: false, event_id: null };
    }
    const pending = await db.query('SELECT count(*)::int AS n FROM social_events WHERE character_id=$1 AND NOT processed', [p.characterId]);
    if (pending.rows[0].n >= 100) throw new DomainError('event_queue_full');
    // Counts processed events too: a fast worker must not bypass the author budget.
    const recent = await db.query(`SELECT count(*)::int AS n FROM social_events
      WHERE character_id=$1 AND audience_id=$2 AND author_id=$3 AND created_at>clock_timestamp()-interval '60 seconds'`,
      [p.characterId, p.audienceId, event.author_id]);
    if (recent.rows[0].n >= 10) throw new DomainError('author_rate_limit');
    const id = randomUUID();
    await db.query(`INSERT INTO social_events(id,character_id,audience_id,source_key,author_id,text,reply_to,author_provenance,author_trust)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, p.characterId, p.audienceId, event.source_key, event.author_id, event.text, event.reply_to ?? null, event.author_provenance, event.author_trust]);
    await db.query('COMMIT');
    return { inserted: true, event_id: id };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
