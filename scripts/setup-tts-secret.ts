import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const path = 'secrets/tts_token';
await mkdir('secrets', { recursive: true, mode: 0o700 });
try {
  await writeFile(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
    throw new Error('TTS secret already exists; refusing to overwrite', { cause: error });
  }
  throw error;
}
console.log('TTS token created. Value is not logged.');
