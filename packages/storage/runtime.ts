import { sourceFingerprint, type ApprovedClaim, type ApprovedDecision } from '../runtime/policy.ts';
import { reserveModelGrant, assertDecisionGrant } from './runtime-authorization.ts';
import { WorkLeaseSchema } from '../runtime/protocol.ts';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DomainError } from '../domain/policy.ts';
import type { Principal } from '../domain/policy.ts';
import { CreateActivitySchema, ClaimWorkSchema, WorkDecisionSchema, ActivityPageSchema, ActivityInputSchema } from '../runtime/contracts.ts';

/** Durable activities. Engine access is gated; runtime leases grant no legacy tools. */
export class RuntimeStore {
  private pool: pg.Pool;
  constructor(pool: pg.Pool) { this.pool = pool; }

  private async transaction<T>(p: Principal, work: (db: pg.PoolClient, state: any) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const state = (await db.query(`SELECT * FROM characters WHERE id=$1 FOR UPDATE`, [p.characterId])).rows[0];
      if (!state) throw new DomainError('character_not_found');
      state.db_now = (await db.query('SELECT clock_timestamp() AS current_time')).rows[0].current_time;
      const result = await work(db, state);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  private async activity(db: pg.PoolClient, p: Principal, id: string) {
    const row = (await db.query(`SELECT * FROM runtime_activities WHERE id=$1 AND character_id=$2 AND audience_id=$3 FOR UPDATE`, [id, p.characterId, p.audienceId])).rows[0];
    if (!row) throw new DomainError('activity_not_found');
    return row;
  }

  private async audit(db: pg.PoolClient, id: string, version: number, actor: string, transition: string) {
    await db.query('INSERT INTO runtime_audit(activity_id,version,actor,transition) VALUES($1,$2,$3,$4)', [id, version, actor, transition]);
  }

  private async wake(db: pg.PoolClient, p: Principal, id: string, key: string, kind: string, at: Date) {
    await db.query(`INSERT INTO runtime_wakeups(id,character_id,audience_id,activity_id,dedup_key,kind,available_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(activity_id,dedup_key) DO NOTHING`,
      [randomUUID(),p.characterId,p.audienceId,id,key,kind,at]);
  }

  /** Only the authenticated owner HTTP route calls this; origin is never taken from input. */
  async assign(p: Principal, input: unknown) {
    const b = CreateActivitySchema.parse(input);
    return this.transaction(p, async (db, state) => {
      const old = (await db.query(`SELECT *,create_payload=$4::jsonb AS matches FROM runtime_activities
        WHERE character_id=$1 AND audience_id=$2 AND invocation_id=$3`, [p.characterId,p.audienceId,b.invocation_id,JSON.stringify(b)])).rows[0];
      if (old) {
        if (!old.matches) throw new DomainError('invocation_conflict');
        const { matches, ...activity } = old;
        return activity;
      }
      if (state.paused) throw new DomainError('paused');
      const count = (await db.query(`SELECT count(*)::int AS n FROM runtime_activities WHERE character_id=$1
        AND status NOT IN ('completed','failed','cancelled')`, [p.characterId])).rows[0].n;
      if (count >= 100) throw new DomainError('activity_queue_full');
      const id = randomUUID();
      const row = (await db.query(`INSERT INTO runtime_activities(id,character_id,audience_id,origin,requested_by,invocation_id,create_payload,objective,max_turns)
        VALUES($1,$2,$3,'owner','owner',$4,$5,$6,$7) RETURNING *`,
        [id,p.characterId,p.audienceId,b.invocation_id,JSON.stringify(b),b.objective,b.max_turns])).rows[0];
      await this.wake(db,p,id,'created','created',state.db_now);
      await this.audit(db,id,1,'owner','created');
      return row;
    });
  }

  async list(p: Principal, limit = 20, offset = 0) {
    ({limit,offset} = ActivityPageSchema.parse({limit,offset}));
    return (await this.pool.query(`SELECT id,objective,origin,requested_by,status,version,max_turns,turns_used,
      coalesce((SELECT h.rule_id FROM runtime_policy_holds h JOIN runtime_policy_current c ON c.character_id=h.character_id AND c.version=h.policy_version
        WHERE h.activity_id=runtime_activities.id AND h.activity_version=runtime_activities.version),
        CASE WHEN turns_used>=max_turns AND status IN ('ready','waiting_time','needs_input') THEN 'activity_turn_budget' END) AS blocked_reason,
      checkpoint_id,question,input_reply,summary,created_at,updated_at FROM runtime_activities
      WHERE character_id=$1 AND audience_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`, [p.characterId,p.audienceId,limit,offset])).rows;
  }

  async inspect(p: Principal, id: string) {
    return this.transaction(p, async (db) => {
      const activity = await this.activity(db,p,id);
      const checkpoint = activity.checkpoint_id ? (await db.query(`SELECT id,state,created_at FROM runtime_checkpoints
        WHERE id=$1 AND activity_id=$2 AND character_id=$3 AND audience_id=$4`, [activity.checkpoint_id,id,p.characterId,p.audienceId])).rows[0] : null;
      return { activity, checkpoint };
    });
  }

  async cancel(p: Principal, id: string, version: number) {
    return this.transaction(p, async (db, state) => {
      const a = await this.activity(db,p,id);
      if (a.version !== version) throw new DomainError('activity_version_conflict');
      if (['completed','failed','cancelled'].includes(a.status)) throw new DomainError('activity_terminal');
      await db.query(`UPDATE runtime_wakeups SET state='cancelled' WHERE activity_id=$1 AND state='pending'`,[id]);
      const turn = (await db.query(`UPDATE runtime_turns SET status='interrupted',finished_at=now()
        WHERE activity_id=$1 AND status='running' RETURNING id,epoch`,[id])).rows[0];
      if (turn && state.active_runtime_turn_id === turn.id && state.epoch === turn.epoch && !state.active_event_id) {
        await db.query(`UPDATE characters SET active_runtime_turn_id=NULL,lease_until=NULL,epoch=epoch+1 WHERE id=$1`,[p.characterId]);
      }
      const row = (await db.query(`UPDATE runtime_activities SET status='cancelled',version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id])).rows[0];
      await this.audit(db,id,row.version,'owner','cancelled');
      return row;
    });
  }

  async provideInput(p: Principal, id: string, input: unknown) {
    const b = ActivityInputSchema.parse(input);
    return this.transaction(p, async (db, state) => {
      if (state.paused) throw new DomainError('paused');
      const a = await this.activity(db,p,id);
      if (a.version !== b.expected_version) throw new DomainError('activity_version_conflict');
      if (a.status !== 'needs_input') throw new DomainError('activity_not_waiting_input');
      const row = (await db.query(`UPDATE runtime_activities SET status='ready',input_reply=$2,version=version+1,updated_at=now()
        WHERE id=$1 RETURNING *`,[id,b.text])).rows[0];
      await this.wake(db,p,id,`input:${row.version}`,'owner_input',state.db_now);
      await this.audit(db,id,row.version,'owner','input_received');
      return row;
    });
  }

  /** Called inside the character lock, before claims; no model or external action is invoked. */
  private async recover(db: pg.PoolClient, state: any) {
    const expired = (await db.query(`SELECT * FROM runtime_turns WHERE character_id=$1 AND status='running'
      AND (epoch<>$2 OR lease_until<=clock_timestamp() OR $3::boolean) FOR UPDATE`,[state.id,state.epoch,state.paused])).rows;
    for (const t of expired) {
      await db.query(`UPDATE runtime_turns SET status='interrupted',finished_at=now() WHERE id=$1`,[t.id]);
      const a = (await db.query(`UPDATE runtime_activities SET status='ready',version=version+1,updated_at=now()
        WHERE id=$1 AND status='running' RETURNING *`,[t.activity_id])).rows[0];
      if (a) {
        await this.wake(db,{characterId:t.character_id,audienceId:t.audience_id},a.id,`recovery:${t.id}`,'recovery',state.db_now);
        await this.audit(db,a.id,a.version,'runtime','interrupted');
      }
      // An expired legacy consumer may already hold the character: never clear its lease.
      if (state.active_runtime_turn_id === t.id && state.epoch === t.epoch && !state.active_event_id) {
        await db.query(`UPDATE characters SET active_runtime_turn_id=NULL,lease_until=NULL,epoch=epoch+1 WHERE id=$1`,[state.id]);
        state.epoch += 1; state.lease_until = null; state.active_runtime_turn_id = null;
      }
    }
  }

  async reconcile(p:Principal) {
    return this.transaction(p,async(db,state)=>{await this.recover(db,state);return {paused:state.paused};});
  }

  async preview(p:Principal,policyVersion:string) {
    const c=(await this.pool.query('SELECT * FROM characters WHERE id=$1',[p.characterId])).rows[0];
    if(!c||c.paused||(c.lease_until&&new Date(c.lease_until).getTime()>Date.now()))return null;
    const a=(await this.pool.query(`SELECT a.*,w.kind AS wake_reason FROM runtime_activities a JOIN runtime_wakeups w ON w.activity_id=a.id
      WHERE a.character_id=$1 AND a.audience_id=$2 AND a.status IN ('ready','waiting_time') AND a.turns_used<a.max_turns
      AND w.state='pending' AND w.available_at<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM runtime_policy_holds h WHERE h.activity_id=a.id AND h.activity_version=a.version AND h.policy_version=$3)
      ORDER BY w.available_at,w.id LIMIT 1`,[p.characterId,p.audienceId,policyVersion])).rows[0];
    if(!a)return null;
    const checkpoint=a.checkpoint_id?(await this.pool.query('SELECT state FROM runtime_checkpoints WHERE id=$1',[a.checkpoint_id])).rows[0].state:null;
    return {activity:a,checkpoint,persona:c.persona,wake_reason:a.wake_reason};
  }

  async claim(p: Principal, input: unknown, approved?:ApprovedClaim): Promise<{work: {activity: any; turn: any; checkpoint: string | null; wake_reason: string} | null; reason?: string}> {
    const b = ClaimWorkSchema.parse(input);
    return this.transaction(p, async (db, state) => {
      await this.recover(db,state);
      if (state.paused) return { work:null, reason:'paused' };
      const old = (await db.query(`SELECT * FROM runtime_turns WHERE character_id=$1 AND audience_id=$2 AND request_id=$3`,[p.characterId,p.audienceId,b.request_id])).rows[0];
      if (old) {
        if (old.status !== 'running' || old.epoch !== state.epoch || state.active_runtime_turn_id !== old.id) return { work:null, reason:'claim_expired' };
        return this.claimResult(db,p,old);
      }
      if (state.lease_until && new Date(state.lease_until) > new Date(state.db_now)) return { work:null, reason:'busy' };
      const daily = (await db.query(`SELECT count(*)::int AS n FROM runtime_turns WHERE character_id=$1 AND created_at>clock_timestamp()-interval '24 hours'`,[p.characterId])).rows[0].n;
      if (daily >= 100) return { work:null, reason:'character_turn_budget' };
      const due = (await db.query(`SELECT a.*,w.id AS wakeup_id FROM runtime_activities a JOIN runtime_wakeups w ON w.activity_id=a.id
        WHERE a.character_id=$1 AND a.audience_id=$2 AND a.status IN ('ready','waiting_time')
        AND a.turns_used<a.max_turns AND w.state='pending' AND w.available_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM runtime_policy_holds h WHERE h.activity_id=a.id AND h.activity_version=a.version AND ($3::text IS NULL OR h.policy_version=$3))
        ORDER BY w.available_at,w.id LIMIT 1 FOR UPDATE OF a,w`,[p.characterId,p.audienceId,approved?.profile.version??null])).rows[0];
      if (!due) return { work:null, reason:'idle_or_budget_blocked' };
      if(approved){
        const checkpoint=due.checkpoint_id?(await db.query('SELECT state FROM runtime_checkpoints WHERE id=$1',[due.checkpoint_id])).rows[0].state:null;
        if(due.id!==approved.activity_id||sourceFingerprint(due,checkpoint,state.persona)!==approved.source_hash)return {work:null,reason:'runtime_context_changed'};
      }
      const epoch = (await db.query(`UPDATE characters SET epoch=epoch+1,lease_until=clock_timestamp()+interval '90 seconds',active_event_id=NULL
        WHERE id=$1 RETURNING epoch,lease_until`,[p.characterId])).rows[0];
      const turn = (await db.query(`INSERT INTO runtime_turns(id,character_id,audience_id,activity_id,request_id,epoch,lease_token,lease_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),p.characterId,p.audienceId,due.id,b.request_id,epoch.epoch,randomUUID(),epoch.lease_until])).rows[0];
      await db.query('UPDATE characters SET active_runtime_turn_id=$2 WHERE id=$1',[p.characterId,turn.id]);
      await db.query(`UPDATE runtime_wakeups SET state='consumed',consumed_by_turn_id=$2 WHERE id=$1`,[due.wakeup_id,turn.id]);
      const a = (await db.query(`UPDATE runtime_activities SET status='running',turns_used=turns_used+1,version=version+1,updated_at=now() WHERE id=$1 RETURNING version`,[due.id])).rows[0];
      if(approved)await reserveModelGrant(db,p,turn,approved);
      await this.audit(db,due.id,a.version,'runtime','claimed');
      return this.claimResult(db,p,turn);
    });
  }

  private async claimResult(db: pg.PoolClient, p: Principal, turn: any) {
    const activity = await this.activity(db,p,turn.activity_id);
    const checkpoint = activity.checkpoint_id ? (await db.query('SELECT state FROM runtime_checkpoints WHERE id=$1 AND activity_id=$2 AND character_id=$3 AND audience_id=$4',[activity.checkpoint_id,activity.id,p.characterId,p.audienceId])).rows[0].state : null;
    const wakeup=(await db.query('SELECT kind FROM runtime_wakeups WHERE consumed_by_turn_id=$1',[turn.id])).rows[0];
    return { work:{ activity, turn, checkpoint, wake_reason:wakeup?.kind??'recovery' } };
  }

  async lease(p: Principal, input: unknown) {
    const b=WorkLeaseSchema.parse(input);
    const row=(await this.pool.query(`SELECT (NOT c.paused AND c.epoch=t.epoch AND c.active_runtime_turn_id=t.id
      AND c.active_event_id IS NULL AND c.lease_until>clock_timestamp() AND t.lease_until>clock_timestamp()
      AND t.status='running' AND a.status='running') AS valid
      FROM runtime_turns t JOIN characters c ON c.id=t.character_id JOIN runtime_activities a ON a.id=t.activity_id
      WHERE t.id=$1 AND t.character_id=$2 AND t.audience_id=$3 AND t.epoch=$4 AND t.lease_token=$5`,
      [b.turn_id,p.characterId,p.audienceId,b.epoch,b.lease_token])).rows[0];
    return {valid:row?.valid===true};
  }

  async assertLegacyTurn(p: Principal) {
    const row=(await this.pool.query('SELECT active_runtime_turn_id FROM characters WHERE id=$1',[p.characterId])).rows[0];
    if(!row)throw new DomainError('character_not_found');
    if(row.active_runtime_turn_id)throw new DomainError('runtime_tools_disabled');
  }

  async decide(p: Principal, input: unknown, approved?:ApprovedDecision) {
    const b = WorkDecisionSchema.parse(input);
    return this.transaction(p, async (db, state) => {
      if (state.paused) throw new DomainError('paused');
      if (state.epoch !== b.epoch) throw new DomainError('stale_epoch');
      const turn = (await db.query(`SELECT * FROM runtime_turns WHERE id=$1 AND character_id=$2 AND audience_id=$3 FOR UPDATE`,[b.turn_id,p.characterId,p.audienceId])).rows[0];
      if (!turn || turn.lease_token !== b.lease_token || turn.epoch !== b.epoch) throw new DomainError('turn_not_found');
      const prior = (await db.query('SELECT *,payload=$2::jsonb AS matches FROM runtime_decisions WHERE turn_id=$1',[turn.id,JSON.stringify(b)])).rows[0];
      if (prior) {
        if (!prior.matches) throw new DomainError('invocation_conflict');
        if(approved)await assertDecisionGrant(db,p,turn,b,approved,true);
        return prior.result;
      }
      if (turn.status !== 'running' || state.active_runtime_turn_id !== turn.id || state.active_event_id) throw new DomainError('turn_not_current');
      if (new Date(turn.lease_until) <= new Date(state.db_now) || !state.lease_until || new Date(state.lease_until) <= new Date(state.db_now)) throw new DomainError('lease_expired');
      const a = await this.activity(db,p,turn.activity_id);
      if (a.version !== b.expected_version) throw new DomainError('activity_version_conflict');
      if (b.decision.action === 'wait_until' && new Date(b.decision.at).getTime() < new Date(state.db_now).getTime()+60_000) throw new DomainError('wakeup_too_soon');
      if(approved)await assertDecisionGrant(db,p,turn,b,approved,false);
      const checkpointId = randomUUID();
      await db.query(`INSERT INTO runtime_checkpoints(id,character_id,audience_id,activity_id,turn_id,state) VALUES($1,$2,$3,$4,$5,$6)`,[checkpointId,p.characterId,p.audienceId,a.id,turn.id,b.checkpoint]);
      const status = {continue:'ready',wait_until:'waiting_time',request_input:'needs_input',complete:'completed'}[b.decision.action];
      const result = (await db.query(`UPDATE runtime_activities SET status=$2,checkpoint_id=$3,question=$4,summary=$5,input_reply=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [a.id,status,checkpointId,b.decision.action==='request_input'?b.decision.question:null,b.decision.action==='complete'?b.decision.summary:null])).rows[0];
      if (b.decision.action==='continue' || b.decision.action==='wait_until') {
        const at = b.decision.action==='wait_until'?new Date(b.decision.at):new Date(new Date(state.db_now).getTime()+60_000);
        await this.wake(db,p,a.id,`decision:${turn.id}`,b.decision.action==='continue'?'continue':'at_time',at);
      }
      await db.query(`UPDATE runtime_turns SET status='finished',finished_at=now() WHERE id=$1`,[turn.id]);
      await db.query(`UPDATE characters SET active_runtime_turn_id=NULL,lease_until=NULL WHERE id=$1`,[p.characterId]);
      await db.query(`INSERT INTO runtime_decisions(turn_id,invocation_id,payload,result) VALUES($1,$2,$3,$4)`,[turn.id,b.invocation_id,JSON.stringify(b),JSON.stringify(result)]);
      await this.audit(db,a.id,result.version,'engine',status);
      return JSON.parse(JSON.stringify(result));
    });
  }
}
