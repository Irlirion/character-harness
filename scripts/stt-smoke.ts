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
const STDERR_TAIL_CHARS = 2048;

const SYNTHESIS_PREFLIGHT =
  'the STT smoke synthesizes real speech with macOS `say` and ffmpeg; both are required';
const REACHABILITY_HINT =
  'start it with `docker compose --profile stt up -d --wait stt`; the usual causes are the container not running, the stt profile not being started, or STT_MODEL_DIR pointing at a directory without the model';

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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// Connection-level failure is reported on its own terms; an HTTP answer from a live service is a
// different problem and gets its own message below, so the two never blur.
async function call(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${base}${path}`, init);
  } catch (cause) {
    const inner = cause instanceof Error ? (cause.cause as NodeJS.ErrnoException | undefined) : undefined;
    throw new Error(`cannot reach the STT service at ${base}: ${inner?.code ?? (cause as Error).message}; ${REACHABILITY_HINT}`, { cause });
  }
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    let total = 0;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      total += chunk.length;
      tail += chunk;
      if (tail.length > STDERR_TAIL_CHARS) tail = tail.slice(-STDERR_TAIL_CHARS);
    });
    child.once('error', reject);
    // 'exit' is enough here: stderr is drained continuously, so the accumulator is already
    // complete when the child exits. Measured, not assumed.
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = tail.trim();
      const truncated = total > STDERR_TAIL_CHARS;
      const suffix = detail === ''
        ? ' with no stderr output'
        : `: ${detail}${truncated ? ` [stderr truncated, showing the last ${detail.length} of ${total} characters]` : ''}`;
      reject(new Error(`${command} exited ${code}${suffix}`));
    });
  });
}

const ready = await call('/ready');
const readyBody = await ready.text();
assert.equal(ready.status, 200, `service at ${base} is reachable but not ready: HTTP ${ready.status}: ${readyBody}`);
assert.deepEqual(parseJson(readyBody), { ready: true }, `unexpected /ready payload from ${base}: ${readyBody}`);

const unauthorized = await call('/transcribe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: Buffer.alloc(200),
});
const unauthorizedBody = await unauthorized.text();
// main.py checks the bearer before the readiness and concurrency gates, so a missing token can only
// come back 401 or 503 not_ready; 429 busy is unreachable here and must not be suggested.
assert.equal(
  unauthorized.status,
  401,
  `missing bearer must be rejected with 401, got HTTP ${unauthorized.status}: ${unauthorizedBody}; without a bearer the service can also answer 503 not_ready if the model unloaded after the /ready probe`,
);
assert.deepEqual(parseJson(unauthorizedBody), { error: 'unauthorized' });

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
  const response = await call('/transcribe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: audio,
  });
  const responseBody = await response.text();
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200, `unexpected status ${response.status}: ${responseBody}`);
  const payload = parseJson(responseBody) as unknown;
  assert.equal(typeof payload, 'object', `response must be a JSON object, got ${responseBody}`);
  const text = payload !== null && typeof payload === 'object' ? (payload as { text?: unknown }).text : undefined;
  if (typeof text !== 'string') assert.fail(`response must carry a string text field, got ${responseBody}`);
  assert.match(text, expectation(firstWord), `transcript must contain the first word "${firstWord}", got ${JSON.stringify(text)}`);
  assert.match(text, expectation(lastWord), `transcript must contain the last word "${lastWord}", got ${JSON.stringify(text)}`);
  console.log(`STT smoke passed in ${elapsed} ms. Transcript: ${text}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}