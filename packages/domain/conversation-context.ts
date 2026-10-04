export type RecentConversationTurn = {
  event_id: string;
  author_id: string;
  author_provenance: 'legacy_unverified_input' | 'owner_input' | 'fabric_profile_context' | 'minecraft_system_chat' | 'minecraft_voice_stt';
  author_trust: 'unverified';
  author_metadata?:Record<string,unknown>;
  input: string;
  reply: string;
};

export function boundRecentConversation(rows: RecentConversationTurn[], maxTurns = 10, maxSerializedChars = 8000): RecentConversationTurn[] {
  const selected: RecentConversationTurn[] = [];
  for (const row of rows) {
    if (selected.length >= maxTurns) break;
    const candidate = [...selected, row];
    if (JSON.stringify(candidate).length <= maxSerializedChars) selected.push(row);
  }
  return selected.reverse();
}

export function makeTurnInput<TEvent, TMemory>(event: TEvent, memories: TMemory[], recentConversation: RecentConversationTurn[], worldObservation?: unknown) {
  const input = { event, memories, recent_conversation: recentConversation };
  return worldObservation === undefined ? input : { ...input, world_observation: worldObservation };
}
