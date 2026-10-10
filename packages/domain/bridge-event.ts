import { z } from 'zod';

export const SYSTEM_CHAT_SERVER = 'mc.agicraft.ru:25565';
const observedProfile = z.object({uuid:z.string().uuid(),name:z.string().regex(/^[A-Za-z0-9_]{1,16}$/)}).strict();
const observedVoicePlayer = observedProfile.extend({distance:z.number().finite().min(0).max(16).optional(),bearing_degrees:z.number().finite().min(-180).max(180).optional(),line_of_sight:z.boolean().optional()}).strict();

const profileEvent = z.object({
  source_key: z.string().regex(/^minecraft:[^\s]{1,300}$/),
  author_id: z.string().uuid(),
  author_provenance: z.literal('fabric_profile_context'),
  text: z.string().min(1).max(1000)
}).strict();

const systemChatEvent = z.object({
  source_key: z.string().regex(/^minecraft-system:mc\.agicraft\.ru:25565:[a-z0-9_]{1,16}:[^\s]{1,300}$/),
  author_id: z.string().regex(/^minecraft-system:mc\.agicraft\.ru:25565:[a-z0-9_]{1,16}$/),
  author_provenance: z.literal('minecraft_system_chat'),
  source_server: z.literal(SYSTEM_CHAT_SERVER),
  text: z.string().min(1).max(1000),
  author_metadata:z.object({observed_profile:observedProfile}).strict().optional()
}).strict();

const voiceEvent = z.object({
  source_key: z.string().regex(/^minecraft-voice:mc\.agicraft\.ru:25565:[0-9a-f-]{36}:[^\s]{1,300}$/),
  author_id: z.string().regex(/^minecraft-voice:mc\.agicraft\.ru:25565:[0-9a-f-]{36}$/),
  author_provenance: z.literal('minecraft_voice_stt'),
  source_server: z.literal(SYSTEM_CHAT_SERVER),
  text: z.string().min(1).max(1000),
  author_metadata:z.object({observed_profile:observedVoicePlayer}).strict().optional()
}).strict();

const bridgeEvent = z.discriminatedUnion('author_provenance', [profileEvent, systemChatEvent, voiceEvent]);

export class BridgeEventScopeError extends Error {
  constructor() {
    super('system_chat_public_demo_required');
  }
}

export type StoredBridgeEvent = {
  source_key:string;author_id:string;text:string;author_provenance:string;source_server?:string;
  author_trust:'unverified';author_metadata:Record<string,unknown>
};

export function parseBridgeEvent(input: unknown, allowSystemChatPublicDemo: boolean, audienceId: string): StoredBridgeEvent {
  const event = bridgeEvent.parse(input);
  if ((event.author_provenance === 'minecraft_system_chat' || event.author_provenance === 'minecraft_voice_stt')
      && (!allowSystemChatPublicDemo || audienceId !== 'demo-public')) {
    throw new BridgeEventScopeError();
  }
  return { ...event, author_trust: 'unverified', author_metadata: 'author_metadata' in event ? event.author_metadata ?? {} : {} };
}
