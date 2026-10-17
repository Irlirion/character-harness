import { TelegramStore } from '../../packages/storage/telegram.ts';
import { buildApp } from './app.ts';
import { readFile } from 'node:fs/promises';
import { loadCharacter } from '../../packages/domain/character.ts';
import { secret } from '../../packages/domain/secrets.ts';
import { pool, status, search, remember, control, ingest, nextEvent, recentConversation, loadSocialContext, inspectEvent, stageMemory, socialCommitmentPage, complete, deferEvent } from '../../packages/storage/db.ts';
import { enqueueSpeech, claimSpeech, speechState, updateSpeech } from '../../packages/storage/speech.ts';
import { enqueueClientAction, clientActionStatus, clientActionLease, claimClientAction, finishClientAction, cancelActiveClientActions } from '../../packages/storage/actions.ts';
import { saveWorldObservation, latestWorldObservation } from '../../packages/storage/observations.ts';

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
const telegram=telegramToken?new TelegramStore(pool,character.id):undefined;
const app = buildApp({
  principal, tokens: { engine: engineToken, owner: ownerToken, audio: audioToken, bridge: bridgeToken,telegram:telegramToken },
  telegram,
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
