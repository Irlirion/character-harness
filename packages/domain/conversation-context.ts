export type RecentConversationTurn = {
  event_id: string;
  author_id: string;
  author_provenance: 'legacy_unverified_input' | 'owner_input' | 'fabric_profile_context' | 'minecraft_system_chat';
  author_trust: 'unverified';
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

export function makeTurnInput<TEvent, TMemory>(event: TEvent, memories: TMemory[], recentConversation: RecentConversationTurn[]) {
  return { event, memories, recent_conversation: recentConversation };
}
