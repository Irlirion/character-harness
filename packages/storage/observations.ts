import type { Principal } from '../domain/policy.ts';
import type { WorldObservation } from '../domain/world-observation.ts';
import { pool } from './db.ts';

export async function saveWorldObservation(p:Principal,o:WorldObservation) {
  const r=await pool.query(`INSERT INTO world_observations(character_id,audience_id,session_id,connected,server,snapshot,received_at)
    VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(character_id,audience_id) DO UPDATE SET
      session_id=excluded.session_id,connected=excluded.connected,server=excluded.server,snapshot=excluded.snapshot,received_at=now()
    WHERE (world_observations.snapshot->>'observed_at')::timestamptz < (excluded.snapshot->>'observed_at')::timestamptz`,
    [p.characterId,p.audienceId,o.session_id,o.connected,o.server,o]);
  return {saved:r.rowCount===1,out_of_order:r.rowCount!==1};
}

export async function latestWorldObservation(p:Principal) {
  const row=(await pool.query(`SELECT snapshot,connected,server,session_id,
      (extract(epoch FROM now()-received_at)*1000)::int AS age_ms
    FROM world_observations WHERE character_id=$1 AND audience_id=$2`,[p.characterId,p.audienceId])).rows[0];
  if(!row)return {available:false,stale:true,connected:false};
  const stale=row.age_ms>2500;
  return {available:true,stale,connected:row.connected&&!stale,session_id:row.session_id,server:row.server,age_ms:row.age_ms,snapshot:row.snapshot};
}
