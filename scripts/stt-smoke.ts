import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const base = process.env.STT_URL ?? 'http://127.0.0.1:3082';
const token = (await readFile(process.env.STT_TOKEN_FILE ?? 'secrets/stt_token', 'utf8')).trim();
const phrase = process.env.STT_SMOKE_PHRASE ?? 'Север, повернись налево';
const voice = process.env.STT_SMOKE_VOICE ?? 'Milena';
const MAX_AUDIO_BYTES = 768_000;

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args);
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

const ready = await fetch(`${base}/ready`);
assert.equal(ready.status, 200, 'service must report ready');
assert.deepEqual(await ready.json(), { ready: true });

const unauthorized = await fetch(`${base}/transcribe`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: Buffer.alloc(200),
});
await unauthorized.arrayBuffer();
assert.equal(unauthorized.status, 401, 'missing bearer must be rejected');

const dir = await mkdtemp(join(tmpdir(), 'stt-smoke-'));
try {
  const aiff = join(dir, 'phrase.aiff');
  const pcm = join(dir, 'phrase.pcm');
  await run('say', ['-v', voice, '-o', aiff, phrase]);
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '48000', '-ac', '1', '-f', 's16le', pcm]);
  const audio = await readFile(pcm);
  assert.equal(audio.length % 2, 0, 'PCM must stay 16-bit aligned');
  assert.ok(audio.length > 0, 'synthesis must produce audio');
  assert.ok(audio.length <= MAX_AUDIO_BYTES, `phrase must fit the 8s cap, got ${audio.length} bytes`);

  const started = Date.now();
  const response = await fetch(`${base}/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: audio,
  });
  assert.equal(response.status, 200, `unexpected status ${response.status}`);
  const { text } = await response.json() as { text: string };
  const elapsed = Date.now() - started;
  assert.equal(typeof text, 'string');
  assert.match(text, /север/i, `transcript must contain the wake name, got ${JSON.stringify(text)}`);
  console.log(`STT smoke passed in ${elapsed} ms. Transcript: ${text}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
