import { z } from 'zod';
import {
  COST_CHANGES,
  COST_SOURCES,
  DETAIL_CODES,
  ENVIRONMENTS,
  NORMALIZATIONS,
} from './enums.js';

const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);

export const CostComponentSchema = z
  .object({
    name: z.string().min(1).max(180),
    monthly_cost: z.number().finite().nullable(),
    unit: z.string().min(1).max(64).optional(),
    quantity: z.number().finite().optional(),
    price: z.number().finite().optional(),
  })
  .strict();

export type CostComponent = z.infer<typeof CostComponentSchema>;

export const CostLineSchema = z
  .object({
    id: z.string().min(1).max(256),
    source: z.enum(COST_SOURCES),
    service: z.string().min(1).max(128),
    resource_type: z.string().min(1).max(128),
    address: z.string().min(1).max(256),
    environment: z.enum(ENVIRONMENTS),
    change: z.enum(COST_CHANGES),
    monthly_cost: z.number().finite().nullable(),
    currency: CurrencySchema,
    unpriced: z.boolean(),
    partial: z.boolean(),
    normalization: z.enum(NORMALIZATIONS),
    detail_code: z.enum(DETAIL_CODES).optional(),
    source_monthly_cost: z.number().finite().optional(),
    source_currency: CurrencySchema.optional(),
    components: z.array(CostComponentSchema).max(32),
  })
  .strict();

export type CostLine = z.infer<typeof CostLineSchema>;

export const CostWindowSchema = z
  .object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.end <= value.start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'window end must be after start',
        path: ['end'],
      });
    }
  });

export type CostWindow = z.infer<typeof CostWindowSchema>;

export function parseCostLine(input: CostLine): CostLine {
  return CostLineSchema.parse(input);
}
