import { readFile } from 'node:fs/promises';
import { pool } from './db.ts';
const db = await pool.connect();
try {
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(420041)');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  for (const version of ['001-core', '002-speech', '003-bridge-delivery', '004-bridge-author-provenance', '005-event-admission', '005-client-actions', '006-voice-stt-provenance', '007-social-memory', '008-memory-staging', '009-reply-channel']) {
    if (!(await db.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version])).rowCount) {
      await db.query(await readFile(new URL(`../../migrations/${version}.sql`, import.meta.url), 'utf8'));
      await db.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
    }
  }
  await db.query('COMMIT');
  console.log('Migrations applied');
} catch (error) { await db.query('ROLLBACK'); throw error; }
finally { db.release(); await pool.end(); }
