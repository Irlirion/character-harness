import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

test('PostgreSQL client actions enforce replay, leases, observation scope, and action fences',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `actions_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let storagePool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    process.env.DATABASE_URL = `${process.env.TEST_DATABASE_URL}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const [{ pool }, actions, observations] = await Promise.all([
      import('../packages/storage/db.ts'), import('../packages/storage/actions.ts'), import('../packages/storage/observations.ts'),
    ]);
    storagePool = pool;
    for (const version of ['001-core', '002-speech', '003-bridge-delivery', '004-bridge-author-provenance', '005-event-admission', '005-client-actions', '006-voice-stt-provenance']) {
      await storagePool.query(await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8'));
    }
    const p = { characterId: 'lada', audienceId: 'demo' };
    const other = { ...p, audienceId: 'other' };
    const session = randomUUID();
    let observedAt = Date.now();
    const timestamp = () => new Date(observedAt += 1000).toISOString();
    const observe = (server = 'mc.agicraft.ru:25565', connected = true, sessionId = session) =>
      observations.saveWorldObservation(p, { session_id: sessionId, connected, server, observed_at: timestamp(), dimension: 'minecraft:overworld', position: { x: 1, y: 64, z: 2 } } as never);
    await storagePool.query("INSERT INTO characters(id,name,persona,lease_until) VALUES('lada','Лада','test',now()+interval '2 minutes')");
    await observe();
    const epoch = (await storagePool.query("SELECT epoch FROM characters WHERE id='lada'")).rows[0].epoch;

    const request = () => actions.enqueueClientAction(p, 'invoke-one', 'walk', { forward: 1 }, 500, epoch);
    const enqueued = await request();
    assert.equal(enqueued.state, 'pending');
    assert.deepEqual(await request(), enqueued, 'same invocation and payload replays the original action');
    await assert.rejects(actions.enqueueClientAction(p, 'invoke-one', 'turn', { degrees: 90 }, 500, epoch), { code: 'invocation_conflict' });
    await assert.rejects(actions.clientActionStatus(other, enqueued.id), { code: 'client_action_not_found' });

    const claimed = await actions.claimClientAction(p);
    assert.ok(claimed?.claim_id);
    assert.equal((await actions.clientActionLease(p, enqueued.id, claimed!.claim_id!)).valid, true);
    assert.equal((await actions.clientActionStatus(p, enqueued.id)).allowed, true);
    assert.deepEqual(await actions.finishClientAction(p, enqueued.id, claimed!.claim_id!, 'completed', { verified: true }), { state: 'completed' });
    assert.equal((await actions.clientActionStatus(p, enqueued.id)).state, 'completed');

    await storagePool.query("UPDATE world_observations SET received_at=now()-interval '3 seconds' WHERE character_id='lada'");
    await assert.rejects(actions.enqueueClientAction(p, 'stale-observation', 'walk', { forward: 1 }, 100, epoch), { code: 'world_observation_stale' });
    await observe();
    await observe('another.example:25565');
    await assert.rejects(actions.enqueueClientAction(p, 'wrong-server', 'walk', { forward: 1 }, 500, epoch), { code: 'world_observation_stale' });
    await observe();
    const wrongServer = await actions.enqueueClientAction(p, 'finish-wrong-server', 'walk', { forward: 1 }, 500, epoch);
    const wrongServerClaim = await actions.claimClientAction(p);
    assert.equal(wrongServerClaim?.id, wrongServer.id);
    await observe('another.example:25565');
    assert.equal((await actions.clientActionLease(p, wrongServer.id, wrongServerClaim!.claim_id!)).valid, false);
    assert.equal((await actions.clientActionStatus(p, wrongServer.id)).allowed, false);
    assert.deepEqual(await actions.finishClientAction(p, wrongServer.id, wrongServerClaim!.claim_id!, 'completed', {}), { state: 'cancelled' });

    await observe();
    const sessionFenced = await actions.enqueueClientAction(p, 'session-fence', 'walk', { forward: 1 }, 500, epoch);
    const sessionClaim = await actions.claimClientAction(p);
    assert.equal(sessionClaim?.id, sessionFenced.id);
    await observe('mc.agicraft.ru:25565', true, randomUUID());
    assert.equal((await actions.clientActionLease(p, sessionFenced.id, sessionClaim!.claim_id!)).valid, false);
    assert.deepEqual(await actions.finishClientAction(p, sessionFenced.id, sessionClaim!.claim_id!, 'completed', {}), { state: 'cancelled' });

    await observe();
    const epochFenced = await actions.enqueueClientAction(p, 'epoch-fence', 'walk', { forward: 1 }, 500, epoch);
    const epochClaim = await actions.claimClientAction(p);
    assert.equal(epochClaim?.id, epochFenced.id);
    await storagePool.query("UPDATE characters SET lease_until=now()-interval '1 second' WHERE id='lada'");
    assert.equal((await actions.clientActionLease(p, epochFenced.id, epochClaim!.claim_id!)).valid, false);
    await storagePool.query("UPDATE characters SET lease_until=now()+interval '2 minutes' WHERE id='lada'");
    await storagePool.query("UPDATE characters SET epoch=epoch+1 WHERE id='lada'");
    assert.equal((await actions.clientActionLease(p, epochFenced.id, epochClaim!.claim_id!)).valid, false);
    assert.deepEqual(await actions.finishClientAction(p, epochFenced.id, epochClaim!.claim_id!, 'completed', {}), { state: 'cancelled' });
    await assert.rejects(actions.enqueueClientAction(p, 'old-epoch', 'walk', { forward: 1 }, 500, epoch), { code: 'stale_epoch' });

    const newEpoch = (await storagePool.query("SELECT epoch FROM characters WHERE id='lada'")).rows[0].epoch;
    await observe();
    const pauseFenced = await actions.enqueueClientAction(p, 'pause-fence', 'walk', { forward: 1 }, 500, newEpoch);
    const pauseClaim = await actions.claimClientAction(p);
    assert.equal(pauseClaim?.id, pauseFenced.id);
    await storagePool.query("UPDATE characters SET paused=true,epoch=epoch+1,lease_until=NULL WHERE id='lada'");
    assert.deepEqual(await actions.finishClientAction(p, pauseFenced.id, pauseClaim!.claim_id!, 'completed', {}), { state: 'cancelled' });

    await storagePool.query("UPDATE characters SET paused=false,epoch=epoch+1,lease_until=now()+interval '2 minutes' WHERE id='lada'");
    const budgetEpoch = (await storagePool.query("SELECT epoch FROM characters WHERE id='lada'")).rows[0].epoch;
    await observe();
    for (let i = 0; i < 4; i++) {
      const item = await actions.enqueueClientAction(p, `budget-${i}`, 'walk', { forward: 1 }, 0, budgetEpoch);
      await storagePool.query("UPDATE client_actions SET state='completed',finished_at=now() WHERE id=$1", [item.id]);
    }
    await assert.rejects(actions.enqueueClientAction(p, 'budget-overflow', 'walk', { forward: 1 }, 0, budgetEpoch), { code: 'client_action_turn_budget' });

  } finally {
    await storagePool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
