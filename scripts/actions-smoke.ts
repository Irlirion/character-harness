import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError, type Principal } from '../packages/domain/policy.ts';
import { pool } from '../packages/storage/db.ts';
import { enqueueClientAction, clientActionLease, claimClientAction, finishClientAction, clientActionStatus } from '../packages/storage/actions.ts';
import { saveWorldObservation } from '../packages/storage/observations.ts';

const suffix = randomUUID();
const principal: Principal = { characterId: `action-smoke-${suffix}`, audienceId: `action-smoke-${suffix}` };
const foreignAudience: Principal = { ...principal, audienceId: `other-${suffix}` };
const session1 = randomUUID();
const session2 = randomUUID();
const epoch = 7;
const expectCode = async (code: string, fn: () => Promise<unknown>) => {
  await assert.rejects(fn, error => error instanceof DomainError && error.code === code);
};
function observation(sessionId: string, observedAt = new Date().toISOString()) {
  return {
    session_id: sessionId, connected: true as const, server: 'mc.agicraft.ru:25565' as const, observed_at: observedAt,
    self: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, on_ground: true, health: 20,
      dimension: 'minecraft:overworld', collision_ahead: false, support_ahead: true },
    players: [], crosshair: { type: 'none' as const },
  };
}

async function main() {
  try {
    await pool.query(`INSERT INTO characters(id,name,persona,paused,epoch,lease_until)
      VALUES($1,'Action smoke','isolated database verification',false,$2,now()+interval '10 minutes')`, [principal.characterId, epoch]);
    await expectCode('world_observation_stale', () => enqueueClientAction(principal, randomUUID(), 'walk', { forward: 1, strafe: 0 }, 300, epoch));
    await saveWorldObservation(principal, observation(session1));
    await expectCode('stale_epoch', () => enqueueClientAction(principal, randomUUID(), 'walk', { forward: 1, strafe: 0 }, 300, epoch - 1));

    const invocation = randomUUID();
    const first = await enqueueClientAction(principal, invocation, 'walk', { forward: 1, strafe: 0 }, 300, epoch);
    const replay = await enqueueClientAction(principal, invocation, 'walk', { forward: 1, strafe: 0 }, 300, epoch);
    assert.equal(replay.id, first.id, 'same invocation replays the same action');
    await expectCode('invocation_conflict', () => enqueueClientAction(principal, invocation, 'walk', { forward: 0, strafe: 1 }, 300, epoch));
    await expectCode('client_action_not_found', () => clientActionStatus(foreignAudience, first.id));

    const claimed = await claimClientAction(principal);
    assert.ok(claimed?.claim_id);
    assert.equal(claimed.session_id, session1);
    assert.equal(await clientActionLease(principal, first.id, randomUUID()).then(v => v.valid), false, 'claim id fences leases');
    assert.equal(await clientActionLease(principal, first.id, claimed.claim_id!).then(v => v.valid), true);
    assert.equal((await finishClientAction(principal, first.id, claimed.claim_id!, 'completed', { observed: true })).state, 'completed');

    const sessionChange = await enqueueClientAction(principal, randomUUID(), 'turn', { yaw_degrees: 30, pitch_degrees: 0 }, 0, epoch);
    const claimedBeforeChange = await claimClientAction(principal);
    assert.equal(claimedBeforeChange?.id, sessionChange.id);
    if (!claimedBeforeChange?.claim_id) throw new Error('session-scoped action was not claimed');
    await saveWorldObservation(principal, observation(session2, new Date(Date.now() + 5).toISOString()));
    assert.equal(await clientActionLease(principal, sessionChange.id, claimedBeforeChange.claim_id!).then(v => v.valid), false,
      'a new client session revokes a claimed action');
    assert.equal((await finishClientAction(principal, sessionChange.id, claimedBeforeChange.claim_id!, 'completed', {})).state, 'cancelled');

    const expiring = await enqueueClientAction(principal, randomUUID(), 'walk', { forward: -1, strafe: 0 }, 250, epoch);
    await pool.query('UPDATE client_actions SET expires_at=now()-interval \'1 second\' WHERE id=$1', [expiring.id]);
    assert.equal((await clientActionStatus(principal, expiring.id)).state, 'expired');
    assert.equal(await claimClientAction(principal), null);

    const paused = await enqueueClientAction(principal, randomUUID(), 'turn', { yaw_degrees: -30, pitch_degrees: 0 }, 0, epoch);
    const pausedClaim = await claimClientAction(principal);
    assert.equal(pausedClaim?.id, paused.id);
    if (!pausedClaim?.claim_id) throw new Error('action was not claimed before pause');
    await pool.query('UPDATE characters SET paused=true,epoch=epoch+1,lease_until=NULL WHERE id=$1', [principal.characterId]);
    assert.equal(await clientActionLease(principal, paused.id, pausedClaim.claim_id!).then(v => v.valid), false, 'pause and epoch change revoke lease');
    assert.equal((await finishClientAction(principal, paused.id, pausedClaim.claim_id!, 'completed', {})).state, 'cancelled');
    console.log('Client action database smoke passed (synthetic isolated character only).');
  } finally {
    await pool.query('DELETE FROM client_actions WHERE character_id=$1', [principal.characterId]);
    await pool.query('DELETE FROM world_observations WHERE character_id=$1', [principal.characterId]);
    await pool.query('DELETE FROM characters WHERE id=$1', [principal.characterId]);
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof DomainError ? error.code : error instanceof Error ? error.message : 'action smoke failed');
  process.exitCode = 1;
});
