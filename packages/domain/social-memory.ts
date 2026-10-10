import { z } from 'zod';

const uuid = z.string().uuid();

/** A proposal produced by an engine. The core supplies no implicit scope. */
export const SocialMemoryDeltaSchema = z.object({
  schema_version: z.literal(1),
  character_id: z.string().min(1).max(200),
  audience_id: z.string().min(1).max(200),
  epoch: z.number().int().positive(),
  base_state_version: z.number().int().nonnegative(),
  people: z.array(z.object({
    channel: z.string().min(1).max(32),
    external_id: z.string().min(1).max(200),
    display_name: z.string().min(1).max(200),
    provenance: z.enum(['owner_input', 'fabric_profile_context', 'minecraft_system_chat', 'legacy_unverified_input']),
    identity_status: z.literal('unverified').default('unverified')
  }).strict()).max(20).default([]),
  facts: z.array(z.object({
    person: z.string().min(1).max(200),
    content: z.string().min(1).max(2000),
    source_event_id: uuid,
    confidence: z.number().min(0).max(1),
    epistemic_status: z.enum(['observed', 'inferred', 'superseded']),
    visibility: z.literal('audience')
  }).strict()).max(50).default([]),
  relationships: z.array(z.object({
    person: z.string().min(1).max(200),
    note: z.string().min(1).max(2000),
    source_event_id: uuid
  }).strict()).max(20).default([]),
  commitments: z.array(z.object({
    key: z.string().min(1).max(200),
    person: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    source_event_id: uuid,
    due_at: z.string().datetime({ offset: true }).optional(),
    status: z.enum(['open', 'fulfilled', 'cancelled']),
    evidence_event_id: uuid.optional()
  }).strict()).max(20).default([]),
  working_state: z.object({
    topic: z.string().max(500).nullable(),
    goal: z.string().max(1000).nullable(),
    open_questions: z.array(z.string().min(1).max(500)).max(20),
    commitment_keys: z.array(z.string().min(1).max(200)).max(20),
    last_event_id: uuid.nullable()
  }).strict().nullable()
}).strict();

export type SocialMemoryDelta = z.infer<typeof SocialMemoryDeltaSchema>;

/** Model-facing proposal. Core binds every identity, source, scope, epoch, and version. */
export const SocialMemoryProposalSchema = z.object({
  person: z.object({ display_name: z.string().min(1).max(200) }).strict().optional(),
  facts: z.array(z.object({
    content: z.string().min(1).max(2000), confidence: z.number().min(0).max(1),
    epistemic_status: z.enum(['observed', 'inferred', 'superseded'])
  }).strict()).max(20).default([]),
  relationships: z.array(z.object({ note: z.string().min(1).max(2000) }).strict()).max(10).default([]),
  commitments: z.array(z.object({
    key: z.string().min(1).max(200), description: z.string().min(1).max(2000),
    due_at: z.string().datetime({ offset: true }).optional(), status: z.enum(['open', 'fulfilled', 'cancelled'])
  }).strict()).max(10).default([]),
  working_state: z.object({
    topic: z.string().max(500).nullable(), goal: z.string().max(1000).nullable(),
    open_questions: z.array(z.string().min(1).max(500)).max(20), commitment_keys: z.array(z.string().min(1).max(200)).max(20)
  }).strict().nullable().optional()
}).strict();

export type SocialMemoryProposal = z.infer<typeof SocialMemoryProposalSchema>;

/** Examples also document that identity and interpretation are separate. */
export const SOCIAL_MEMORY_EXAMPLES = {
  introduction: { channel: 'minecraft', external_id: 'uuid:abc', display_name: 'Sasha', provenance: 'fabric_profile_context', identity_status: 'unverified' },
  relationship: { person: 'uuid:abc', note: 'Lada enjoyed discussing settlement names with Sasha', source_event_id: '00000000-0000-4000-8000-000000000001' },
  commitment: { key: 'settlement-name-followup', person: 'uuid:abc', description: 'Discuss the two settlement name options next time', source_event_id: '00000000-0000-4000-8000-000000000001', status: 'open' },
  contradiction: 'Record a newer sourced observation and mark the old fact superseded; do not silently overwrite it.',
  audienceIsolation: 'Every entity and memory row is scoped by character and audience; channel identities are never joined implicitly.'
} as const;
