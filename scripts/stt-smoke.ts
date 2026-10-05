import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const base = process.env.STT_URL ?? 'http://127.0.0.1:3082';
const token = (await readFile(process.env.STT_TOKEN_FILE ?? 'secrets/stt_token', 'utf8')).trim();
const phrase = process.env.STT_SMOKE_PHRASE ?? 'Север, повернись налево';
const voice = process.env.STT_SMOKE_VOICE ?? 'Milena';
const MAX_AUDIO_BYTES = 768_000;

const SYNTHESIS_PREFLIGHT =
  'the STT smoke synthesizes real speech with macOS `say` and ffmpeg; both are required';

assert.equal(
  process.platform,
  'darwin',
  `${SYNTHESIS_PREFLIGHT}, but this host platform is ${process.platform}`,
);
for (const binary of ['say', 'ffmpeg']) {
  const probe = spawnSync(binary, [], { stdio: 'ignore' });
  assert.ok(!probe.error, `${binary} is not on PATH: ${SYNTHESIS_PREFLIGHT}`);
}

// The expectation is derived from the phrase so STT_SMOKE_PHRASE stays coherent: edge punctuation is
// dropped because the CTC vocabulary emits none, and ё folds to е because the model normalises it.
const words = phrase
  .split(/\s+/)
  .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/ё/giu, 'е'))
  .filter(Boolean);
assert.ok(words.length > 0, `phrase must contain at least one word, got ${JSON.stringify(phrase)}`);
const firstWord = words[0];
const lastWord = words[words.length - 1];

function expectation(word: string): RegExp {
  return new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      const detail = stderr.trim();
      const suffix = detail ? `: ${detail}` : '';
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}${suffix}`));
    });
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
const unauthorizedBody = await unauthorized.text();
assert.equal(unauthorized.status, 401, `missing bearer must be rejected: ${unauthorizedBody}`);
assert.deepEqual(JSON.parse(unauthorizedBody), { error: 'unauthorized' });

const dir = await mkdtemp(join(tmpdir(), 'stt-smoke-'));
try {
  const aiff = join(dir, 'phrase.aiff');
  const pcm = join(dir, 'phrase.pcm');
  await run('say', ['-v', voice, '-o', aiff, phrase]);
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '48000', '-ac', '1', '-f', 's16le', pcm]);
  const audio = await readFile(pcm);
  assert.ok(audio.length > 0, 'synthesis must produce audio');
  assert.equal(audio.length % 2, 0, `byte count must be a whole number of 16-bit samples, got ${audio.length} bytes`);
  assert.ok(audio.length <= MAX_AUDIO_BYTES, `phrase must fit the 8s cap, got ${audio.length} bytes`);

  const started = Date.now();
  const response = await fetch(`${base}/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: audio,
  });
  const responseBody = await response.text();
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200, `unexpected status ${response.status}: ${responseBody}`);
  const payload = JSON.parse(responseBody) as unknown;
  assert.equal(typeof payload, 'object', `response must be a JSON object, got ${responseBody}`);
  const text = payload !== null && typeof payload === 'object' ? (payload as { text?: unknown }).text : undefined;
  if (typeof text !== 'string') assert.fail(`response must carry a string text field, got ${responseBody}`);
  assert.match(text, expectation(firstWord), `transcript must contain the first word "${firstWord}", got ${JSON.stringify(text)}`);
  assert.match(text, expectation(lastWord), `transcript must contain the last word "${lastWord}", got ${JSON.stringify(text)}`);
  console.log(`STT smoke passed in ${elapsed} ms. Transcript: ${text}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}