import { boundRecentConversation, type RecentConversationTurn } from '../domain/conversation-context.ts';
import type { Principal } from '../domain/policy.ts';

export const RECENT_CONVERSATION_SQL = `SELECT e.id AS event_id,e.author_id,e.author_provenance,e.author_trust,e.text AS input,r.text AS reply
  FROM social_events current_event
  JOIN social_events e ON e.character_id=current_event.character_id AND e.audience_id=current_event.audience_id
  JOIN replies r ON r.event_id=e.id
  WHERE current_event.id=$3 AND current_event.character_id=$1 AND current_event.audience_id=$2
    AND e.character_id=$1 AND e.audience_id=$2 AND e.processed=true
    AND (e.created_at,e.id) < (current_event.created_at,current_event.id)
  ORDER BY e.created_at DESC,e.id DESC LIMIT 10`;

export async function loadRecentConversation(
  query: (sql: string, values: unknown[]) => Promise<{ rows: RecentConversationTurn[] }>,
  principal: Principal,
  currentEventId: string
): Promise<RecentConversationTurn[]> {
  const { rows } = await query(RECENT_CONVERSATION_SQL, [principal.characterId, principal.audienceId, currentEventId]);
  return boundRecentConversation(rows);
}
