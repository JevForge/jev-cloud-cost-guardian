import { z } from 'zod';
import { DECISIONS, REASON_CODES } from './enums.js';
import { CostLineSchema, CostWindowSchema } from './cost.js';

export const CostDecisionSchema = z
  .object({
    decision: z.enum(DECISIONS),
    confidence: z.number().min(0).max(1),
    reason_codes: z.array(z.enum(REASON_CODES)).min(1).max(24),
    currency: z.string().regex(/^[A-Z]{3}$/),
    environment: z.string().min(1).max(32),
    window: CostWindowSchema,
    baseline_monthly: z.number().finite().nullable(),
    delta_monthly: z.number().finite(),
    projected_monthly: z.number().finite().nullable(),
    budget_monthly: z.number().finite().nonnegative(),
    budget_remaining: z.number().finite().nullable(),
    utilization: z.number().finite().nullable(),
    summary: z.string().min(1).max(500),
    explanation: z.string().max(2_000),
    provisional: z.boolean(),
    findings: z.array(CostLineSchema).max(5_000),
    sources: z.array(z.string().min(1).max(64)).max(16),
    unpriced_count: z.number().int().nonnegative(),
    partial_count: z.number().int().nonnegative(),
  })
  .strict();

export type CostDecision = z.infer<typeof CostDecisionSchema>;
