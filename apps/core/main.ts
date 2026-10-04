import { buildApp } from './app.ts';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { secret } from '../../packages/domain/secrets.ts';
import { pool, status, search, remember, control, ingest, nextEvent, recentConversation, complete, deferEvent } from '../../packages/storage/db.ts';
import { enqueueSpeech, claimSpeech, speechState, updateSpeech } from '../../packages/storage/speech.ts';

const principal = { characterId: process.env.CHARACTER_ID ?? 'sever', audienceId: process.env.AUDIENCE_ID ?? 'demo-public' };
const engineToken = secret('ENGINE_TOKEN');
const ownerToken = secret('OWNER_TOKEN');
const audioToken = secret('AUDIO_TOKEN');
const bridgeToken = secret('BRIDGE_TOKEN');
const systemChatDemoSetting = process.env.BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO ?? 'false';
if (systemChatDemoSetting !== 'true' && systemChatDemoSetting !== 'false') throw new Error('BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO must be true or false');
const allowSystemChatPublicDemo = systemChatDemoSetting === 'true';
if (audioToken.length < 32 || audioToken === ownerToken || audioToken === engineToken) throw new Error('Distinct audio token required');
if (bridgeToken.length < 32 || new Set([bridgeToken, ownerToken, engineToken, audioToken]).size !== 4) throw new Error('Distinct bridge token required');
if (engineToken.length < 32 || ownerToken.length < 32 || engineToken === ownerToken) throw new Error('Distinct tokens of at least 32 characters required');
const character = z.object({ id: z.string(), name: z.string(), persona: z.string() }).parse(
  JSON.parse(await readFile(process.env.CHARACTER_FILE ?? 'characters/sever.json', 'utf8')));
if (character.id !== principal.characterId) throw new Error('Character binding mismatch');
await pool.query(`INSERT INTO characters(id,name,persona) VALUES($1,$2,$3)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,persona=excluded.persona`, [character.id, character.name, character.persona]);

const app = buildApp({
  principal, tokens: { engine: engineToken, owner: ownerToken, audio: audioToken, bridge: bridgeToken },
  allowSystemChatPublicDemo,
  deps: { pool, status, search, remember, control, ingest, nextEvent, recentConversation, complete, deferEvent,
    enqueueSpeech, claimSpeech, speechState, updateSpeech }
});
const shutdown = async () => { await app.close(); await pool.end(); };
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
