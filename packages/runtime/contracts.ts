import { z } from 'zod';

export const ActivityStatusSchema = z.enum(['ready', 'running', 'waiting_time', 'needs_input', 'completed', 'failed', 'cancelled']);
export const CreateActivitySchema = z.object({
  invocation_id: z.string().min(1).max(200),
  objective: z.string().trim().min(1).max(4000),
  max_turns: z.number().int().min(1).max(100).default(10),
}).strict();
export const ClaimWorkSchema = z.object({ request_id: z.string().min(1).max(200), engine:z.enum(['pi','codex']).optional(), model:z.string().min(1).max(200).optional() }).strict();
export const DecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('continue') }).strict(),
  z.object({ action: z.literal('wait_until'), at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ action: z.literal('request_input'), question: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.literal('complete'), summary: z.string().trim().min(1).max(4000) }).strict(),
]);
export const WorkDecisionSchema = z.object({
  invocation_id: z.string().min(1).max(200), turn_id: z.uuid(), lease_token: z.uuid(),
  epoch: z.number().int().positive(), expected_version: z.number().int().positive(),
  checkpoint: z.string().max(16_000), decision: DecisionSchema,
}).strict();
export const CancelActivitySchema = z.object({ expected_version: z.number().int().positive() }).strict();
export type CreateActivity = z.infer<typeof CreateActivitySchema>;
export type WorkDecision = z.infer<typeof WorkDecisionSchema>;
export const ActivityPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
}).strict();

/** This flag exposes owner storage only, never inference or autonomous effects. */
export function runtimeStorageEnabled(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('RUNTIME_STORAGE_ENABLED must be true or false');
}

export const ActivityInputSchema = z.object({
  expected_version: z.number().int().positive(), text: z.string().trim().min(1).max(4000),
}).strict();
