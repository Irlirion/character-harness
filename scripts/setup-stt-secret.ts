import { randomBytes } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';

const path = 'secrets/stt_token';
await mkdir('secrets', { recursive: true, mode: 0o700 });
try {
  await access(path);
  throw new Error('STT secret already exists; refusing to overwrite');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}
await writeFile(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
console.log('STT token created. Value is not logged.');
