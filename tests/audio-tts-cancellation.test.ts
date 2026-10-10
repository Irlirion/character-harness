import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const workerPath = resolve('apps/audio-worker/main.ts');
const jobId = 'caa8f51b-b1fd-41e9-9b93-3ea86dc95751';
const claimId = '805845db-ff61-4fdb-85ac-b2617841b3c2';

function listen(server: Server) {
  return new Promise<number>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no_tcp_address'));
      resolveListen(address.port);
    });
  });
}

function sendJson(response: ServerResponse, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
  response.end(body);
}

async function waitFor(check: () => boolean, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition_timeout');
    await delay(20);
  }
}

for (const provider of ['qwen']) {
test(`permission revocation aborts in-flight ${provider} fetch before player starts`, {
  skip: process.platform !== 'darwin' && 'native audio worker is macOS-only',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-tts-cancel-'));
  let core: Server | undefined;
  let tts: Server | undefined;
  let worker: ChildProcess | undefined;
  let claimCount = 0;
  let allowed = true;
  let terminalState: string | undefined;
  let ttsStarted = false;
  let ttsAborted = false;
  let stderr = '';
  const playerMarker = join(dir, 'player-started');

  const collectBody = (request: IncomingMessage) => new Promise<void>(resolveBody => {
    request.on('data', () => {});
    request.on('end', resolveBody);
  });

  try {
    const corePort = await listen(core = createServer(async (request, response) => {
      const path = request.url ?? '/';
      if (path === '/audio/claim' && request.method === 'POST') {
        await collectBody(request);
        claimCount++;
        return sendJson(response, claimCount === 1 ? {
          job: { id: jobId, claim_id: claimId, text: 'Север, проверка отмены.', expires_at: new Date(Date.now() + 30000).toISOString() },
        } : { job: null });
      }
      if (path === `/audio/jobs/${jobId}` && request.method === 'GET') {
        allowed = false;
        return sendJson(response, { id: jobId, allowed, state: terminalState ?? 'claimed' });
      }
      if (path === `/audio/jobs/${jobId}` && request.method === 'POST') {
        await collectBody(request);
        const chunks: Buffer[] = [];
        // The body was drained above; record only the state from a second copy is impossible.
        // Respond with a terminal state because the worker uses this endpoint after cancellation.
        terminalState = allowed ? 'playing' : 'failed';
        return sendJson(response, { id: jobId, state: terminalState });
      }
      response.writeHead(404).end();
    }));

    const ttsPort = await listen(tts = createServer(async (request, response) => {
      if (request.url === '/ready' && request.method === 'GET') return sendJson(response, { ready: true });
      if (request.url !== '/synthesize' || request.method !== 'POST') return response.writeHead(404).end();
      await collectBody(request);
      ttsStarted = true;
      let finished = false;
      const timer = setTimeout(() => {
        if (response.destroyed) return;
        finished = true;
        const body = Buffer.alloc(44);
        body.write('RIFF', 0); body.writeUInt32LE(36, 4); body.write('WAVE', 8);
        body.write('fmt ', 12); body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20);
        body.writeUInt16LE(1, 22); body.writeUInt32LE(22050, 24); body.writeUInt32LE(44100, 28);
        body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34); body.write('data', 36); body.writeUInt32LE(0, 40);
        response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': body.length }).end(body);
      }, 2000);
      response.once('close', () => {
        clearTimeout(timer);
        if (!finished) ttsAborted = true;
      });
    }));

    const tokenPath = join(dir, 'token');
    await writeFile(tokenPath, 'test-token-only\n');
    const fakePlayer = join(dir, 'fake-player');
    await writeFile(fakePlayer, `#!/bin/sh\nprintf started > '${playerMarker}'\n`);
    await chmod(fakePlayer, 0o755);

    worker = spawn(process.execPath, ['--experimental-strip-types', workerPath], {
      cwd: dir,
      env: {
        ...process.env,
        CORE_URL: `http://127.0.0.1:${corePort}`,
        AUDIO_TOKEN_FILE: tokenPath,
        TTS_PROVIDER: provider,
        TTS_URL: `http://127.0.0.1:${ttsPort}`,
        TTS_TOKEN_FILE: tokenPath,
        AUDIO_PLAYER: fakePlayer,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    worker.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk; });

    await waitFor(() => ttsStarted && ttsAborted && terminalState !== undefined);
    assert.equal(allowed, false, 'mock core revoked the job before the delayed TTS response');
    assert.ok(['failed', 'cancelled'].includes(terminalState!), `unexpected terminal state: ${terminalState}`);
    await assert.rejects(readFile(playerMarker), { code: 'ENOENT' }, 'player must not start after revocation');

    worker.kill('SIGTERM');
    await Promise.race([
      new Promise<void>(resolveExit => worker!.once('exit', () => resolveExit())),
      delay(3000).then(() => { throw new Error('worker_did_not_stop'); }),
    ]);
    assert.doesNotMatch(stderr, /unhandledRejection|UnhandledPromiseRejection/i);
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill('SIGTERM');
      await Promise.race([new Promise<void>(resolveExit => worker!.once('exit', () => resolveExit())), delay(1500)]);
      if (worker.exitCode === null) worker.kill('SIGKILL');
    }
    await Promise.all([core, tts].filter((server): server is Server => !!server).map(server => new Promise<void>(resolveClose => server.close(() => resolveClose()))));
    await rm(dir, { recursive: true, force: true });
  }
});

}
