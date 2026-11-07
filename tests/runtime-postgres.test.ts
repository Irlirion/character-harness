import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { RuntimeStore } from '../packages/storage/runtime.ts';
import type { WorkDecision } from '../packages/runtime/contracts.ts';

// Use a unique schema; never touch deployment data or require model credentials.
test('runtime persistence, claims, fencing and recovery', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const schema = `runtime_${randomUUID().replaceAll('-','')}`;
  const admin = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options',`-c search_path=${schema}`);
    pool = new pg.Pool({connectionString:url.toString(),max:8});
    const db = pool;
    // Match migrate.ts, including both 005 migrations in its explicit order.
    const versions = (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
    const eventIndex=versions.indexOf('005-event-admission.sql');
    const actionIndex=versions.indexOf('005-client-actions.sql');
    [versions[actionIndex],versions[eventIndex]]=[versions[eventIndex],versions[actionIndex]];
    for (const version of versions) await db.query(await readFile(new URL(`../migrations/${version}`,import.meta.url),'utf8'));
    await db.query("INSERT INTO characters(id,name,persona) VALUES('lada','Lada','test'),('other','Other','test')");
    const p = {characterId:'lada',audienceId:'demo'};
    const store = new RuntimeStore(db);
    const reset = async () => {
      await db.query("UPDATE characters SET paused=false,epoch=epoch+1,lease_until=NULL,active_event_id=NULL,active_runtime_turn_id=NULL");
      await db.query('UPDATE runtime_activities SET checkpoint_id=NULL');
      await db.query('TRUNCATE runtime_activities,runtime_turns,runtime_checkpoints,runtime_wakeups,runtime_decisions,runtime_audit CASCADE');
      await db.query("INSERT INTO characters(id,name,persona) VALUES('lada','Lada','test'),('other','Other','test')");
    };
    const assign = (key='a',max_turns=10) => store.assign(p,{invocation_id:key,objective:'Remember the plan',max_turns});
    const claim = async (request_id='claim') => {
      const r = await store.claim(p,{request_id}); assert.ok(r.work); return r.work;
    };
    const decision = (work: any, change: Partial<WorkDecision> = {}): WorkDecision => ({
      invocation_id:randomUUID(),turn_id:work.turn.id,lease_token:work.turn.lease_token,
      epoch:work.turn.epoch,expected_version:work.activity.version,checkpoint:'Agent-owned plan',
      decision:{action:'complete',summary:'Local planning complete; no external effects'},...change,
    });
    const expire = async (id: string) => {
      await db.query("UPDATE runtime_turns SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
      await db.query("UPDATE characters SET lease_until=clock_timestamp()-interval '1 second' WHERE id='lada'");
    };

    await t.test('assignment replay, strict origin and scope isolation', async () => {
      const a = await assign();
      assert.equal((await assign()).id,a.id);
      await assert.rejects(store.assign(p,{invocation_id:'a',objective:'Changed'}),{code:'invocation_conflict'});
      await assert.rejects(store.assign(p,{invocation_id:'b',objective:'Forged',origin:'self'}));
      for (const other of [{...p,audienceId:'other'},{...p,characterId:'other'}]) {
        assert.deepEqual(await store.list(other),[]);
        await assert.rejects(store.inspect(other,a.id),{code:'activity_not_found'});
        await assert.rejects(store.cancel(other,a.id,1),{code:'activity_not_found'});
      }
      assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_wakeups')).rows[0].n,1);
    });

    await reset();
    await t.test('racing engines reserve only one turn; retry returns same claim', async () => {
      await assign();
      const results = await Promise.all([store.claim(p,{request_id:'one'}),store.claim(p,{request_id:'two'})]);
      assert.equal(results.filter(r=>r.work).length,1);
      const winner = results.find(r=>r.work)!.work!;
      const repeated=await store.claim(p,{request_id:winner.turn.request_id});
      assert.equal(repeated.work!.turn.id,winner.turn.id);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_turns')).rows[0].n,1);
      assert.equal(winner.activity.turns_used,1);
      await assert.rejects(store.decide({...p,audienceId:'private'},decision(winner)),{code:'turn_not_found'});
    });

    await reset();
    await t.test('checkpoint and wait commit atomically; store restart resumes the same work', async () => {
      const a = await assign(); const w = await claim();
      const b=decision(w,{decision:{action:'wait_until',at:new Date(Date.now()+120_000).toISOString()}});
      const saved=await store.decide(p,b);
      assert.equal(saved.status,'waiting_time');
      assert.deepEqual(await store.decide(p,b),saved);
      await assert.rejects(store.decide(p,{...b,checkpoint:'Different'}),{code:'invocation_conflict'});
      assert.equal((await store.claim(p,{request_id:'sleep'})).work,null);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_checkpoints')).rows[0].n,1);
      await db.query("UPDATE runtime_wakeups SET available_at=clock_timestamp()-interval '1 second' WHERE state='pending'");
      const restarted = new RuntimeStore(db);
      const next=await restarted.claim(p,{request_id:'wake'}); assert.ok(next.work);
      assert.equal(next.work.activity.id,a.id); assert.equal(next.work.checkpoint,b.checkpoint);
      await restarted.decide(p,decision(next.work));
      assert.equal((await restarted.inspect(p,a.id)).activity.status,'completed');
      assert.equal((await store.claim(p,{request_id:'terminal'})).work,null);
    });

    await reset();
    await t.test('bad decisions do not partially write a checkpoint or consume a turn', async () => {
      await assign();const w=await claim();
      await assert.rejects(store.decide(p,decision(w,{expected_version:1})),{code:'activity_version_conflict'});
      await assert.rejects(store.decide(p,decision(w,{decision:{action:'wait_until',at:new Date().toISOString()}})),{code:'wakeup_too_soon'});
      await assert.rejects(store.decide(p,decision(w,{lease_token:randomUUID()})),{code:'turn_not_found'});
      assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_checkpoints')).rows[0].n,0);
      assert.equal((await store.inspect(p,w.activity.id)).activity.status,'running');
    });

    await reset();
    await t.test('pause immediately revokes turns atomically, without losing the goal', async () => {
      const a=await assign();const w=await claim();
      // Exercise the same atomic UPDATE as existing owner control, without a second pause API.
      await db.query("UPDATE characters SET paused=true,epoch=epoch+1,lease_until=NULL,active_event_id=NULL WHERE id='lada'");
      assert.equal((await store.inspect(p,a.id)).activity.status,'ready');
      assert.equal((await db.query('SELECT status FROM runtime_turns WHERE id=$1',[w.turn.id])).rows[0].status,'interrupted');
      await assert.rejects(store.decide(p,decision(w)),{code:'paused'});
      assert.equal((await store.claim(p,{request_id:'paused'})).work,null);
      await assert.rejects(assign('paused'),{code:'paused'});
      await db.query("UPDATE characters SET paused=false,epoch=epoch+1 WHERE id='lada'");
      await assert.rejects(store.decide(p,decision(w)),{code:'stale_epoch'});
      const resumed=await claim('resumed');assert.equal(resumed.activity.id,a.id);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM runtime_wakeups WHERE kind='recovery'")).rows[0].n,1);
    });

    await reset();
    await t.test('expired lease recovers once and retains charged budget', async () => {
      await assign();const w=await claim(); await expire(w.turn.id);
      await assert.rejects(store.decide(p,decision(w)),{code:'lease_expired'});
      const old=await store.claim(p,{request_id:'claim'});assert.equal(old.work,null);assert.equal(old.reason,'claim_expired');
      const next=await claim('recovered'); assert.notEqual(next.turn.id,w.turn.id);
      assert.equal(next.activity.turns_used,2);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM runtime_wakeups WHERE kind='recovery'")).rows[0].n,1);
    });

    await reset();
    await t.test('activity budget blocks recovery without inventing completion', async () => {
      const a=await assign('limited',1);const w=await claim();await expire(w.turn.id);
      assert.equal((await store.claim(p,{request_id:'no-budget'})).work,null);
      const row=(await store.list(p))[0];assert.equal(row.blocked_reason,'activity_turn_budget');
      assert.equal(row.status,'ready');assert.equal(row.objective,a.objective);
    });

    await reset();
    await t.test('continue has minimum interval; owner input unblocks needs_input', async () => {
      const a=await assign();const w=await claim();
      await store.decide(p,decision(w,{decision:{action:'continue'}}));
      assert.equal((await store.claim(p,{request_id:'too-soon'})).work,null);
      await db.query("UPDATE runtime_wakeups SET available_at=clock_timestamp()-interval '1 second' WHERE state='pending'");
      const next=await claim('second');
      const saved=await store.decide(p,decision(next,{decision:{action:'request_input',question:'Which project?'}}));
      assert.equal((await store.claim(p,{request_id:'needs-input'})).work,null);
      await assert.rejects(store.provideInput({...p,audienceId:'other'},a.id,{expected_version:saved.version,text:'Private'}),{code:'activity_not_found'});
      await store.provideInput(p,a.id,{expected_version:saved.version,text:'The bridge'});
      const after=await claim('answer');assert.equal(after.activity.input_reply,'The bridge');
      const done=await store.decide(p,decision(after));assert.equal(done.input_reply,null);
    });

    await reset();
    await t.test('cancel fences active work and rejects stale versions', async () => {
      const a=await assign();const w=await claim();
      await assert.rejects(store.cancel(p,a.id,1),{code:'activity_version_conflict'});
      const cancelled=await store.cancel(p,a.id,w.activity.version);assert.equal(cancelled.status,'cancelled');
      await assert.rejects(store.decide(p,decision(w)),{code:'stale_epoch'});
      assert.equal((await store.claim(p,{request_id:'after-cancel'})).work,null);
    });

    await reset();
    await t.test('legacy lease and runtime lease cannot overlap or release each other', async () => {
      await assign();
      await db.query("UPDATE characters SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id='lada'");
      assert.equal((await store.claim(p,{request_id:'legacy-busy'})).reason,'busy');
      await db.query("UPDATE characters SET lease_until=NULL WHERE id='lada'");
      const w=await claim(); await expire(w.turn.id);
      // Simulate a legacy consumer claiming an expired character lease.
      await db.query("UPDATE characters SET epoch=epoch+1,lease_until=clock_timestamp()+interval '90 seconds' WHERE id='lada'");
      assert.equal((await store.claim(p,{request_id:'legacy-again'})).reason,'busy');
      await store.cancel(p,w.activity.id,(await store.inspect(p,w.activity.id)).activity.version);
      assert.ok((await db.query("SELECT lease_until>clock_timestamp() AS live FROM characters WHERE id='lada'")).rows[0].live);
    });

    await reset();
    await t.test('rolling character turn budget survives a new store and does not consume a wakeup', async () => {
      const a=await assign();
      const rows=Array.from({length:100},(_,i)=>({id:randomUUID(),request_id:`spent:${i}`,lease_token:randomUUID()}));
      await db.query(`INSERT INTO runtime_turns(id,character_id,audience_id,activity_id,request_id,epoch,lease_token,lease_until,status)
        SELECT x.id::uuid,$2,$3,$4,x.request_id,1,x.lease_token::uuid,now(),'finished'
        FROM jsonb_to_recordset($1::jsonb) AS x(id text,request_id text,lease_token text)`,[JSON.stringify(rows),p.characterId,p.audienceId,a.id]);
      assert.equal((await new RuntimeStore(db).claim(p,{request_id:'daily-blocked'})).reason,'character_turn_budget');
      assert.equal((await store.inspect(p,a.id)).activity.turns_used,0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM runtime_wakeups WHERE state='pending'")).rows[0].n,1);
      await db.query("UPDATE runtime_turns SET created_at=now()-interval '25 hours'");
      assert.ok((await store.claim(p,{request_id:'after-window'})).work);
    });

    await reset();
    await t.test('failure after checkpoint insert rolls back all lifecycle writes', async () => {
      await assign();const w=await claim();
      await db.query(`CREATE FUNCTION reject_runtime_decision() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END; $$;
        CREATE TRIGGER reject_runtime_decision BEFORE INSERT ON runtime_decisions
        FOR EACH ROW EXECUTE FUNCTION reject_runtime_decision()`);
      try {
        await assert.rejects(store.decide(p,decision(w,{decision:{action:'continue'}})),/synthetic receipt failure/);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM runtime_checkpoints')).rows[0].n,0);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM runtime_wakeups WHERE state='pending'")).rows[0].n,0);
        assert.equal((await store.inspect(p,w.activity.id)).activity.version,w.activity.version);
        assert.equal((await db.query('SELECT status FROM runtime_turns WHERE id=$1',[w.turn.id])).rows[0].status,'running');
      } finally {
        await db.query('DROP TRIGGER reject_runtime_decision ON runtime_decisions; DROP FUNCTION reject_runtime_decision()');
      }
      await store.decide(p,decision(w));
    });

    await reset();
    await t.test('composite FKs reject checkpoints from another activity', async () => {
      const a=await assign('one');const b=await assign('two');const w=await claim();
      await store.decide(p,decision(w));
      const checkpoint=(await store.inspect(p,w.activity.id)).activity.checkpoint_id;
      const target=w.activity.id===a.id?b.id:a.id;
      await assert.rejects(db.query('UPDATE runtime_activities SET checkpoint_id=$1 WHERE id=$2',[checkpoint,target]),{code:'23503'});
    });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
