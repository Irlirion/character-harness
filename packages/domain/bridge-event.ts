import { z } from 'zod';

export const SYSTEM_CHAT_SERVER = 'mc.agicraft.ru:25565';

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
  text: z.string().min(1).max(1000)
}).strict();

const bridgeEvent = z.discriminatedUnion('author_provenance', [profileEvent, systemChatEvent]);

export class BridgeEventScopeError extends Error {
  constructor() {
    super('system_chat_public_demo_required');
  }
}

export type StoredBridgeEvent = z.infer<typeof bridgeEvent> & { author_trust: 'unverified' };

export function parseBridgeEvent(input: unknown, allowSystemChatPublicDemo: boolean, audienceId: string): StoredBridgeEvent {
  const event = bridgeEvent.parse(input);
  if (event.author_provenance === 'minecraft_system_chat'
      && (!allowSystemChatPublicDemo || audienceId !== 'demo-public')) {
    throw new BridgeEventScopeError();
  }
  return { ...event, author_trust: 'unverified' };
}
