import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ingestEvent } from '../packages/storage/events.ts';

test('PostgreSQL admission serializes concurrent writes, preserves replay, and counts processed messages',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `admission_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 12 });
  const p = { characterId: 'sever', audienceId: 'demo' };
  const event = (key: string, author = 'player') => ({ source_key: key, author_id: author, text: 'hi', author_provenance: 'owner_input', author_trust: 'unverified' as const });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const version of ['001-core', '002-speech', '003-bridge-delivery', '004-bridge-author-provenance', '005-event-admission']) {
      await pool.query(await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8'));
    }
    await pool.query("INSERT INTO characters(id,name,persona) VALUES('sever','test','test')");
    const authorBurst = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => ingestEvent(pool, p, event(`burst-${i}`))));
    assert.equal(authorBurst.filter(r => r.status === 'fulfilled').length, 10);
    for (const r of authorBurst) if (r.status === 'rejected') assert.equal(r.reason.code, 'author_rate_limit');
    const saved = (await pool.query('SELECT source_key FROM social_events LIMIT 1')).rows[0].source_key;
    assert.deepEqual(await ingestEvent(pool, p, event(saved)), { inserted: false, event_id: null });
    await pool.query('UPDATE social_events SET processed=true');
    await assert.rejects(ingestEvent(pool, p, event('processed-budget')), { code: 'author_rate_limit' });
    await pool.query("UPDATE social_events SET created_at=now()-interval '61 seconds'");
    assert.equal((await ingestEvent(pool, p, event('window-reset'))).inserted, true);
    await pool.query('TRUNCATE social_events CASCADE');
    const queueBurst = await Promise.allSettled(Array.from({ length: 102 }, (_, i) => ingestEvent(pool,
      { ...p, audienceId: i % 2 ? 'other' : 'demo' }, event(`queue-${i}`, `author-${i}`))));
    assert.equal(queueBurst.filter(r => r.status === 'fulfilled').length, 100);
    for (const r of queueBurst) if (r.status === 'rejected') assert.equal(r.reason.code, 'event_queue_full');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM social_events')).rows[0].n, 100);
    const stored = (await pool.query('SELECT source_key,audience_id FROM social_events LIMIT 1')).rows[0];
    assert.deepEqual(await ingestEvent(pool, { ...p, audienceId: stored.audience_id }, event(stored.source_key)), { inserted: false, event_id: null });
    await pool.query('UPDATE social_events SET processed=true WHERE id=(SELECT id FROM social_events LIMIT 1)');
    assert.equal((await ingestEvent(pool, p, event('space-freed', 'new-author'))).inserted, true);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
