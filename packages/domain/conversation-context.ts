export type RecentConversationTurn = {
  event_id: string;
  author_id: string;
  author_provenance: 'legacy_unverified_input' | 'owner_input' | 'fabric_profile_context' | 'minecraft_system_chat' | 'minecraft_voice_stt' | 'telegram';
  author_trust: 'unverified';
  author_metadata?:Record<string,unknown>;
  input: string;
  reply: string | null;
  assistant_silent?: boolean;
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

export type SocialContextSource = { event_id: string; source_type: string; author_provenance: string; created_at: string };
export type SocialContextInput = {
  working_state: { version: number; topic: string | null; goal: string | null; open_questions: string[]; commitment_keys: string[]; last_event_id: string | null } | null;
  current_person: { display_name: string; identity_status: 'unverified' } | null;
  facts: Array<{ content: string; confidence: number; epistemic_status: string; source: SocialContextSource }>;
  relationships: Array<{ note: string; version: number; source: SocialContextSource }>;
  commitments: Array<{ key: string; description: string; status: string; due_at: string | null; person_ref?: string; source: SocialContextSource }>;
  other_open_commitment_count: number;
  counts?: { facts: number; relationships: number; commitments: number };
};

export type BoundedSocialContext = SocialContextInput & { omitted: { facts: number; relationships: number; commitments: number; state_questions: number; state_commitment_keys: number }; serialized_chars: number };

function serializedLength(value: Record<string, unknown>): number {
  let chars=0;
  for(let i=0;i<4;i++){const next=JSON.stringify({...value,serialized_chars:chars}).length;if(next===chars)return next;chars=next;}
  return JSON.stringify({...value,serialized_chars:chars}).length;
}

/** Keep speaker commitments first, then sourced relationship/fact detail under a fixed budget. */
export function boundSocialContext(input: SocialContextInput, maxSerializedChars = 6000): BoundedSocialContext {
  const context: BoundedSocialContext = {
    working_state: input.working_state,
    current_person: input.current_person,
    facts: [], relationships: [], commitments: [],
    other_open_commitment_count: input.other_open_commitment_count,
    omitted: {
      facts: Math.max(0, (input.counts?.facts ?? input.facts.length)),
      relationships: Math.max(0, (input.counts?.relationships ?? input.relationships.length)),
      commitments: Math.max(0, (input.counts?.commitments ?? input.commitments.length)),state_questions:0,state_commitment_keys:0
    },
    serialized_chars: 0
  };
  // Cap the replaceable projection independently; source records and obligations remain in storage.
  if (context.working_state) {
    const state = context.working_state;
    let bounded = { ...state, topic: state.topic?.slice(0, 300) ?? null, goal: state.goal?.slice(0, 700) ?? null, open_questions: [] as string[], commitment_keys: [] as string[] };
    // Keep version/last event even if the descriptive state exceeds its own 2k budget.
    for (const question of state.open_questions) {
      const candidate = { ...bounded, open_questions: [...bounded.open_questions, question.slice(0, 300)] };
      if (JSON.stringify(candidate).length > 2000) {context.omitted.state_questions++;continue;}
      bounded = candidate;
    }
    for (const key of state.commitment_keys) {
      const candidate = { ...bounded, commitment_keys: [...bounded.commitment_keys, key] };
      if (JSON.stringify(candidate).length > 2000) {context.omitted.state_commitment_keys++;continue;}
      bounded = candidate;
    }
    while (JSON.stringify(bounded).length > 2000) {
      if (bounded.goal) bounded = { ...bounded, goal: bounded.goal.slice(0, Math.max(0, bounded.goal.length - 100)) };
      else if (bounded.topic) bounded = { ...bounded, topic: bounded.topic.slice(0, Math.max(0, bounded.topic.length - 50)) };
      else break;
    }
    context.working_state = bounded;
  }
  const push = <K extends 'commitments' | 'relationships' | 'facts'>(key: K, rows: BoundedSocialContext[K] extends Array<infer R> ? R[] : never, originalCount: number) => {
    for (const row of rows) {
      const candidate = { ...context, [key]: [...context[key], row] };
      if (serializedLength(candidate) > maxSerializedChars) continue;
      context[key].push(row as never);
      context.omitted[key] = Math.max(0, (input.counts?.[key] ?? originalCount) - context[key].length);
    }
  };
  push('commitments', input.commitments, input.commitments.length);
  push('relationships', input.relationships, input.relationships.length);
  push('facts', input.facts, input.facts.length);
  context.serialized_chars = serializedLength(context as unknown as Record<string,unknown>);
  return context;
}

export function makeTurnInput<TEvent, TMemory, TSocial>(
  event: TEvent, memories: TMemory[], recentConversation: RecentConversationTurn[], worldObservation?: unknown, socialMemory?: TSocial, agentDesk?: {revision:number;notes:string;plan:string}
) {
  const current=event&&typeof event==='object'?(event as {author_id?:string}).author_id:undefined;
  if(!current)return {event,memories,recent_conversation:recentConversation,...(worldObservation===undefined?{}:{world_observation:worldObservation}),...(socialMemory===undefined?{}:{social_memory:socialMemory}),...(agentDesk===undefined?{}:{agent_desk:agentDesk})};
  const speakers=new Map<string,string>();
  if(current)speakers.set(current,'current_speaker');
  for(const turn of recentConversation)if(!speakers.has(turn.author_id))speakers.set(turn.author_id,`participant_${speakers.size}`);
  const safeEvent = event && typeof event === 'object' ? {...Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'author_id' && key !== 'source_key')),
    ...(speakers.has(current)?{speaker_ref:speakers.get(current)}:{})} : event;
  const history = recentConversation.map(({ author_id, ...turn }) => ({...turn,...(speakers.has(author_id)?{speaker_ref:speakers.get(author_id)}:{})}));
  return { event: safeEvent, memories, recent_conversation: history, ...(worldObservation===undefined?{}:{world_observation:worldObservation}),...(socialMemory === undefined ? {} : { social_memory: socialMemory }),...(agentDesk===undefined?{}:{agent_desk:agentDesk}) };
}
