import { RuntimeAuthorizationStore } from '../../packages/storage/runtime-authorization.ts';
import { createProcessReviewer,loadReviewerConfig } from '../../packages/runtime/reviewer.ts';
import { RuntimeAudienceGate } from '../../packages/runtime/audience-gate.ts';
import { RuntimePolicyGate } from '../../packages/runtime/gate.ts';
import { RuntimeStore } from '../../packages/storage/runtime.ts';
import { runtimeStorageEnabled } from '../../packages/runtime/contracts.ts';
import { ImageStore } from '../../packages/storage/images.ts';
import { TelegramStore } from '../../packages/storage/telegram.ts';
import { buildApp } from './app.ts';
import { readFile } from 'node:fs/promises';
import { loadCharacter } from '../../packages/domain/character.ts';
import { secret } from '../../packages/domain/secrets.ts';
import { pool, status, search, remember, control, ingest, nextEvent, recentConversation, loadSocialContext, inspectEvent, stageMemory, socialCommitmentPage, complete, deferEvent } from '../../packages/storage/db.ts';
import { enqueueSpeech, claimSpeech, speechState, updateSpeech } from '../../packages/storage/speech.ts';
import { enqueueClientAction, clientActionStatus, clientActionLease, claimClientAction, finishClientAction, cancelActiveClientActions } from '../../packages/storage/actions.ts';
import { saveWorldObservation, latestWorldObservation } from '../../packages/storage/observations.ts';

const enableRuntimeStorage = runtimeStorageEnabled(process.env.RUNTIME_STORAGE_ENABLED);
const character = await loadCharacter(process.env.CHARACTER_FILE, process.env.CHARACTER_ID);
const principal = { characterId: character.id, audienceId: process.env.AUDIENCE_ID ?? 'demo-public' };
const engineToken = secret('ENGINE_TOKEN');
const ownerToken = secret('OWNER_TOKEN');
const audioToken = secret('AUDIO_TOKEN');
const bridgeToken = secret('BRIDGE_TOKEN');
const systemChatDemoSetting = process.env.BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO ?? 'false';
if (systemChatDemoSetting !== 'true' && systemChatDemoSetting !== 'false') throw new Error('BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO must be true or false');
const allowSystemChatPublicDemo = systemChatDemoSetting === 'true';
const memoryInstructions=await readFile(new URL('../../characters/memory-rules.md',import.meta.url),'utf8');
const responseInstructions=await readFile(new URL('../../characters/social-response-rules.md',import.meta.url),'utf8');
const clientWorldSetting = process.env.BRIDGE_CLIENT_WORLD_ENABLED ?? 'false';
if (clientWorldSetting !== 'true' && clientWorldSetting !== 'false') throw new Error('BRIDGE_CLIENT_WORLD_ENABLED must be true or false');
const allowClientWorld = clientWorldSetting === 'true';
if (audioToken.length < 32 || audioToken === ownerToken || audioToken === engineToken) throw new Error('Distinct audio token required');
if (bridgeToken.length < 32 || new Set([bridgeToken, ownerToken, engineToken, audioToken]).size !== 4) throw new Error('Distinct bridge token required');
if (engineToken.length < 32 || ownerToken.length < 32 || engineToken === ownerToken) throw new Error('Distinct tokens of at least 32 characters required');
await pool.query(`INSERT INTO characters(id,name,persona) VALUES($1,$2,$3)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,persona=excluded.persona`, [character.id, character.name, character.persona]);

const telegramToken=process.env.TELEGRAM_WORKER_TOKEN_FILE || process.env.TELEGRAM_WORKER_TOKEN ? secret('TELEGRAM_WORKER_TOKEN') : undefined;
if(telegramToken && (telegramToken.length<32 || new Set([telegramToken,engineToken,ownerToken,audioToken,bridgeToken]).size!==5)) throw new Error('Distinct Telegram worker token required');
const runtime=enableRuntimeStorage?new RuntimeStore(pool):undefined;
const telegram=telegramToken?new TelegramStore(pool,character.id,runtime):undefined;
const runtimeAuth=runtime?new RuntimeAuthorizationStore(pool):undefined;
const reviewerConfig=runtime?await loadReviewerConfig(process.env.RUNTIME_REVIEWER_CONFIG_FILE):undefined;
const reviewer=reviewerConfig&&runtimeAuth?createProcessReviewer(reviewerConfig,(signal,binding)=>runtimeAuth.reserveReview(principal,reviewerConfig.max_requests_24h,signal,binding)):undefined;
const app = buildApp({
  principal, tokens: { engine: engineToken, owner: ownerToken, audio: audioToken, bridge: bridgeToken,telegram:telegramToken },
  telegram,
  runtime, runtimeEngine:runtime,
  // A reviewer bridge requires explicit operator configuration; no profile is installed automatically.
  runtimePolicy:runtime&&runtimeAuth?new RuntimeAudienceGate(new RuntimePolicyGate(runtime,runtimeAuth,reviewer,reviewerConfig?reviewerConfig.timeout_ms+100:2000),pool):undefined,
  images:telegram && process.env.TELEGRAM_IMAGES_ENABLED==='true'?new ImageStore(pool,character.id):undefined,
  allowSystemChatPublicDemo, allowClientWorld,
  memoryInstructions,
  responseInstructions,
  deps: { pool, status, search, remember, control, ingest, nextEvent:p=>nextEvent(p,!!telegram), recentConversation, loadSocialMemory:loadSocialContext, inspectEvent, stageMemory, socialCommitmentPage, complete, deferEvent,
    enqueueSpeech, claimSpeech, speechState, updateSpeech, enqueueClientAction, clientActionStatus, clientActionLease, claimClientAction, finishClientAction, saveWorldObservation, latestWorldObservation, cancelClientActions:cancelActiveClientActions }
});
const shutdown = async () => { await app.close(); await pool.end(); };
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
