import { randomUUID } from 'node:crypto';
import type { Principal } from '../domain/policy.ts';
import { assertActive, assertReplay, DomainError } from '../domain/policy.ts';
import { pool } from './db.ts';

export type ClientActionKind = 'walk' | 'turn' | 'goto';
export type ClientAction = { id: string; kind: ClientActionKind; args: Record<string, number>; duration_ms: number; claim_id?: string; epoch: number; session_id:string; expires_at: string };
const terminal = new Set(['completed', 'failed', 'cancelled', 'expired']);

export async function cancelActiveClientActions(p:Principal) {
  await pool.query(`UPDATE client_actions SET state='cancelled',evidence='{"reason":"client_world_disabled"}'::jsonb,finished_at=now()
    WHERE character_id=$1 AND audience_id=$2 AND state IN ('pending','claimed')`,[p.characterId,p.audienceId]);
  return {cancelled:true};
}

export async function enqueueClientAction(p: Principal, invocationId: string, kind: ClientActionKind, args: Record<string, number>, durationMs: number, epoch: number) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const c = (await db.query('SELECT * FROM characters WHERE id=$1 FOR UPDATE', [p.characterId])).rows[0];
    if (!c) throw new DomainError('character_not_found');
    assertActive(c, epoch);
    if (c.active_runtime_turn_id) throw new DomainError('runtime_tools_disabled');
    if (!c.lease_until || new Date(c.lease_until).getTime() <= Date.now()) throw new DomainError('lease_expired');
    const observation=(await db.query(`SELECT session_id,snapshot FROM world_observations WHERE character_id=$1 AND audience_id=$2
      AND connected AND server='mc.agicraft.ru:25565' AND received_at>now()-interval '2500 milliseconds' FOR SHARE`,[p.characterId,p.audienceId])).rows[0];
    if(!observation)throw new DomainError('world_observation_stale');
    const old = (await db.query(`SELECT id,state,epoch,expires_at,kind,args,duration_ms FROM client_actions WHERE character_id=$1 AND audience_id=$2 AND invocation_id=$3`, [p.characterId, p.audienceId, invocationId])).rows[0];
    if (old) {
      const canonical=(value:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
      assertReplay(canonical({kind,args:canonical(args),durationMs}), canonical({kind:old.kind,args:canonical(old.args),durationMs:old.duration_ms}));
      await db.query('COMMIT'); return {id:old.id,state:old.state,epoch:old.epoch,expires_at:new Date(old.expires_at).toISOString()};
    }
    const active = await db.query("SELECT 1 FROM client_actions WHERE character_id=$1 AND audience_id=$2 AND state IN ('pending','claimed') AND expires_at>now() LIMIT 1", [p.characterId,p.audienceId]);
    if (active.rowCount) throw new DomainError('client_action_busy');
    if(kind==='goto'){
      const self=observation.snapshot?.self;
      if(self?.navigation_backend!=='unionclef_mcp')throw new DomainError('unionclef_not_ready');
      if(!Number.isInteger(durationMs)||durationMs<1000||durationMs>20000
        ||Object.keys(args).sort().join(',')!=='x,y,z'||![args.x,args.y,args.z].every(Number.isSafeInteger)
        ||Math.abs(args.x)>30000000||Math.abs(args.z)>30000000||args.y < -4096||args.y>4096
        ||Math.hypot(args.x+0.5-self.x,args.y-self.y,args.z+0.5-self.z)>32)throw new DomainError('invalid_navigation_target');
    }
    const budget=(await db.query(`SELECT count(*)::int AS n,coalesce(sum(duration_ms),0)::int AS duration_ms FROM client_actions
      WHERE character_id=$1 AND audience_id=$2 AND epoch=$3 AND created_at>now()-interval '2 minutes'`,[p.characterId,p.audienceId,c.epoch])).rows[0];
    if(budget.n>=4||budget.duration_ms+durationMs>(kind==='goto'?20000:4000))throw new DomainError('client_action_turn_budget');
    const id = randomUUID();
    const expires = new Date(Date.now() + durationMs + 4000).toISOString();
    await db.query(`INSERT INTO client_actions(id,character_id,audience_id,invocation_id,epoch,session_id,kind,args,duration_ms,state,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`, [id,p.characterId,p.audienceId,invocationId,c.epoch,observation.session_id,kind,args,durationMs,expires]);
    await db.query('COMMIT');
    return { id, state: 'pending', epoch: c.epoch, expires_at: expires };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export async function clientActionStatus(p: Principal, id: string) {
  await pool.query(`UPDATE client_actions SET state='expired',finished_at=now()
    WHERE id=$1 AND character_id=$2 AND audience_id=$3 AND state IN ('pending','claimed') AND expires_at<=now()`, [id,p.characterId,p.audienceId]);
  const row = (await pool.query(`SELECT a.id,a.state,a.kind,a.evidence,a.expires_at,
      (NOT c.paused AND c.epoch=a.epoch AND c.lease_until>now() AND EXISTS(SELECT 1 FROM world_observations o
        WHERE o.character_id=a.character_id AND o.audience_id=a.audience_id AND o.connected AND o.server='mc.agicraft.ru:25565' AND o.session_id=a.session_id
          AND o.received_at>now()-interval '2500 milliseconds')) AS allowed
    FROM client_actions a JOIN characters c ON c.id=a.character_id
    WHERE a.id=$1 AND a.character_id=$2 AND a.audience_id=$3`, [id,p.characterId,p.audienceId])).rows[0];
  if (!row) throw new DomainError('client_action_not_found');
  return row;
}

export async function clientActionLease(p: Principal, id: string, claimId: string) {
  const r = (await pool.query(`SELECT (a.state='claimed' AND a.claim_id=$4 AND NOT c.paused AND c.epoch=a.epoch
      AND c.lease_until>now() AND a.expires_at>now() AND o.connected AND o.session_id=a.session_id
      AND o.server='mc.agicraft.ru:25565' AND o.received_at>now()-interval '2500 milliseconds') AS valid
    FROM client_actions a JOIN characters c ON c.id=a.character_id LEFT JOIN world_observations o ON o.character_id=a.character_id AND o.audience_id=a.audience_id
    WHERE a.id=$1 AND a.character_id=$2 AND a.audience_id=$3`, [id,p.characterId,p.audienceId,claimId])).rows[0];
  if (!r) throw new DomainError('client_action_not_found');
  return { valid: r.valid === true };
}

export async function claimClientAction(p: Principal): Promise<ClientAction | null> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const c = (await db.query('SELECT paused,epoch,lease_until FROM characters WHERE id=$1 FOR UPDATE', [p.characterId])).rows[0];
    await db.query(`UPDATE client_actions a SET state=CASE WHEN a.state='pending' THEN 'expired' ELSE 'cancelled' END,finished_at=now()
      WHERE a.character_id=$1 AND a.audience_id=$5 AND a.state IN ('pending','claimed') AND (a.expires_at<=now() OR a.epoch<>$2 OR $3 OR $4::timestamptz IS NULL OR $4::timestamptz<=now()
        OR NOT EXISTS(SELECT 1 FROM world_observations o WHERE o.character_id=a.character_id AND o.audience_id=a.audience_id
          AND o.connected AND o.session_id=a.session_id AND o.server='mc.agicraft.ru:25565' AND o.received_at>now()-interval '2500 milliseconds'))`, [p.characterId,c?.epoch ?? -1,c?.paused ?? true,c?.lease_until ?? null,p.audienceId]);
    if (!c || c.paused || !c.lease_until || new Date(c.lease_until).getTime() <= Date.now()) { await db.query('COMMIT'); return null; }
    const row = (await db.query(`SELECT a.id,a.kind,a.args,a.duration_ms,a.epoch,a.session_id,a.expires_at FROM client_actions a
      JOIN world_observations o ON o.character_id=a.character_id AND o.audience_id=a.audience_id AND o.session_id=a.session_id
      WHERE a.character_id=$1 AND a.audience_id=$2 AND a.state='pending' AND a.epoch=$3 AND a.expires_at>now()
        AND o.connected AND o.server='mc.agicraft.ru:25565' AND o.received_at>now()-interval '2500 milliseconds'
      ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`, [p.characterId,p.audienceId,c.epoch])).rows[0];
    if (!row) { await db.query('COMMIT'); return null; }
    const claimId = randomUUID();
    await db.query("UPDATE client_actions SET state='claimed',claim_id=$2 WHERE id=$1", [row.id,claimId]);
    await db.query('COMMIT');
    return { id: row.id, kind: row.kind, args: row.args, duration_ms: row.duration_ms, epoch: row.epoch, session_id:row.session_id, expires_at: row.expires_at, claim_id: claimId };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export async function finishClientAction(p: Principal, id: string, claimId: string, state: 'completed'|'failed'|'cancelled', evidence: unknown) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const c = (await db.query('SELECT paused,epoch,lease_until FROM characters WHERE id=$1 FOR UPDATE', [p.characterId])).rows[0];
    const a = (await db.query(`SELECT state,claim_id,epoch,session_id,expires_at FROM client_actions WHERE id=$1 AND character_id=$2 AND audience_id=$3 FOR UPDATE`, [id,p.characterId,p.audienceId])).rows[0];
    if (!a || a.claim_id !== claimId || a.state !== 'claimed') throw new DomainError('invalid_client_action_claim');
    const obs=(await db.query(`SELECT connected,server,session_id,received_at FROM world_observations WHERE character_id=$1 AND audience_id=$2 FOR SHARE`,[p.characterId,p.audienceId])).rows[0];
    const revoked = !c || c.paused || c.epoch !== a.epoch || !c.lease_until || new Date(c.lease_until).getTime() <= Date.now() || new Date(a.expires_at).getTime() <= Date.now()
      || !obs || !obs.connected || obs.server!=='mc.agicraft.ru:25565' || obs.session_id!==a.session_id || new Date(obs.received_at).getTime() < Date.now()-2500;
    const next = revoked ? 'cancelled' : state;
    await db.query('UPDATE client_actions SET state=$2,evidence=$3,finished_at=now() WHERE id=$1', [id,next,evidence]);
    await db.query('COMMIT');
    return { state: next };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
