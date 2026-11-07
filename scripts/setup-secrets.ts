import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('secrets', { recursive: true, mode: 0o700 });
try { await access('secrets/db_password'); throw new Error('Secrets already exist; refusing to overwrite'); }
catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
const db = randomBytes(32).toString('hex');
const values = {
  db_password: db, database_url: `postgresql://harness:${db}@postgres:5432/harness`,
  engine_token: randomBytes(32).toString('hex'), owner_token: randomBytes(32).toString('hex'),
  audio_token: randomBytes(32).toString('hex'), bridge_token: randomBytes(32).toString('hex'), model_api_key: ''
};
for (const [name,value] of Object.entries(values)) await writeFile(`secrets/${name}`,value+'\n',{ mode: 0o600, flag: 'wx' });
console.log('Secret files created. Fill model_api_key only for live Pi; values are not logged.');
