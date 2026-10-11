import { z } from 'zod';

export const TurnFinishDecisionSchema=z.discriminatedUnion('decision',[
  z.object({decision:z.literal('reply'),text:z.string().trim().min(1).max(256),channel:z.enum(['voice','chat'])}).strict(),
  z.object({decision:z.literal('silent')}).strict()
]);
export type TurnFinishDecision=z.infer<typeof TurnFinishDecisionSchema>;
