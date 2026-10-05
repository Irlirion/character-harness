import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { secret } from '../../packages/domain/secrets.ts';
import { spokenText } from '../../packages/domain/speech-text.ts';

if (process.platform !== 'darwin') throw new Error('Audio worker requires macOS');

const base = process.env.CORE_URL ?? 'http://127.0.0.1:3000';
const url = new URL(base);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Local core required');

const token = secret('AUDIO_TOKEN');
const device = process.env.AUDIO_DEVICE ?? 'Character Harness Voice';
const player = resolve(process.env.AUDIO_PLAYER ?? 'work/voice-spike/harness-audio-play');
const provider = process.env.TTS_PROVIDER ?? 'piper';
if (provider !== 'say' && provider !== 'piper') throw new Error('TTS_PROVIDER must be piper or say');
const voice = process.env.MACOS_TTS_VOICE ?? 'Milena';
const ttsUrl = process.env.TTS_URL ?? 'http://127.0.0.1:3081';
let ttsToken: string | undefined;
if (provider === 'piper') {
  const tts = new URL(ttsUrl);
  if (tts.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(tts.hostname)
    || tts.username || tts.password || tts.pathname !== '/' || tts.search || tts.hash) {
    throw new Error('TTS_URL must be a local HTTP endpoint');
  }
  ttsToken = secret('TTS_TOKEN');
}

let stopped = false;
let running: ChildProcess | undefined;
let activeCancel: (() => void) | undefined;

type Job = { id: string; claim_id: string; text: string; expires_at: string };

function stop() {
  stopped = true;
  activeCancel?.();
  running?.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const wait = () => new Promise<void>(r => setTimeout(r, 500));

async function api(path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(2000),
  });
  if (!r.ok) throw new Error('core_request_failed');
  return r.json();
}

async function withJobFence<T>(
  job: Job,
  operation: Promise<T>,
  onCancel: () => void = () => {},
  timeoutMs?: number,
): Promise<T> {
  let cancelled = false;
  let checking = false;
  let rejectCancelled!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const halt = (reason = 'speech_cancelled') => {
    if (cancelled) return;
    cancelled = true;
    onCancel();
    rejectCancelled(new Error(reason));
  };
  const cancelActive = () => halt();
  activeCancel = cancelActive;
  const remainingMs = new Date(job.expires_at).getTime() - Date.now();
  const watchdog = setTimeout(() => halt('speech_expired'), Math.min(35000, Math.max(1, remainingMs)));
  const requestWatchdog = timeoutMs === undefined ? undefined : setTimeout(() => halt('tts_request_timeout'), timeoutMs);
  const poll = setInterval(() => {
    if (checking) return;
    checking = true;
    void api(`/audio/jobs/${job.id}`)
      .then(state => { if (!state.allowed || stopped) halt(); })
      .catch(() => halt())
      .finally(() => { checking = false; });
  }, 250);
  try {
    if (stopped) halt();
    return await Promise.race([operation, cancellation]);
  } finally {
    clearTimeout(watchdog);
    if (requestWatchdog) clearTimeout(requestWatchdog);
    clearInterval(poll);
    if (activeCancel === cancelActive) activeCancel = undefined;
  }
}

async function readBoundedBody(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error('tts_response_size_invalid');
  }
  if (!response.body) throw new Error('tts_response_body_missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('tts_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
}

async function synthesizePiper(file: string, job: Job, spoken: string) {
  if (!ttsToken) throw new Error('tts_token_missing');
  const controller = new AbortController();
  const request = fetch(new URL('/synthesize', ttsUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${ttsToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: spoken }),
    signal: controller.signal,
  }).then(async response => {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`tts_http_${response.status}`);
    }
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'audio/wav') {
      await response.body?.cancel();
      throw new Error('tts_response_type_invalid');
    }
    const wav = await readBoundedBody(response, 2_000_000);
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('tts_response_wav_invalid');
    }
    await writeFile(file, wav, { flag: 'wx' });
  });
  await withJobFence(job, request, () => controller.abort(), 5000);
}

async function processAudio(command: string, args: string[], job: Job) {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
  running = child;
  const completion = new Promise<void>((resolveCompletion, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveCompletion() : reject(new Error('audio_process_failed')));
  });
  try {
    await withJobFence(job, completion, () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    });
  } finally {
    if (running === child) running = undefined;
  }
}

await mkdir('work/audio', { recursive: true });
if (provider === 'piper') {
  const ready = await fetch(new URL('/ready', ttsUrl), { signal: AbortSignal.timeout(3000) });
  if (!ready.ok) throw new Error('tts_service_not_ready');
  await ready.body?.cancel();
}
console.log(JSON.stringify({ event: 'audio_worker_ready', device, tts_provider: provider }));

while (!stopped) {
  let job: Job | undefined;
  let dir: string | undefined;
  try {
    const claimed = await api('/audio/claim', {});
    job = claimed.job;
    if (!job) {
      await wait();
      continue;
    }

    dir = await mkdtemp('work/audio/speech-');
    const file = resolve(dir, 'speech.wav');
    const spoken = spokenText(job.text);
    if (!spoken) {
      console.log(JSON.stringify({ event: 'speech_nothing_to_say', speech_id: job.id }));
      await api(`/audio/jobs/${job.id}`, { claim_id: job.claim_id, state: 'completed' });
      continue;
    }
    if (provider === 'piper') {
      const piperFile = resolve(dir, 'speech-22050.wav');
      await synthesizePiper(piperFile, job, spoken);
      await processAudio('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', piperFile,
        '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file,
      ], job);
    } else {
      await processAudio('/usr/bin/say', [
        '-v', voice, '-o', file, '--file-format=WAVE', '--data-format=LEI16@48000', spoken,
      ], job);
    }
    if (stopped) throw new Error('speech_cancelled');

    const state = await api(`/audio/jobs/${job.id}`, { claim_id: job.claim_id, state: 'playing' });
    if (state.state !== 'playing') throw new Error('speech_cancelled');
    await processAudio(player, [device, file], job);
    await api(`/audio/jobs/${job.id}`, { claim_id: job.claim_id, state: 'completed' });
    console.log(JSON.stringify({ event: 'speech_completed', speech_id: job.id }));
  } catch (e) {
    if (job) await api(`/audio/jobs/${job.id}`, { claim_id: job.claim_id, state: stopped ? 'cancelled' : 'failed' }).catch(() => {});
    console.error(JSON.stringify({ event: 'audio_attempt_failed', error_type: e instanceof Error ? e.message : 'unknown' }));
    if (!stopped) await wait();
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
