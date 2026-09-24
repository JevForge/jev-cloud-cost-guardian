import { z } from 'zod';
import type { EnvironmentName } from '../schemas/enums.js';
import type { CostLine } from '../schemas/cost.js';
import { parseCost } from '../utils/money.js';
import { parseYamlOrJson } from '../utils/fs.js';
import { makeLine } from './line.js';
import type { CollectResult } from './types.js';

const ComponentInput = z
  .object({
    name: z.string().min(1),
    monthly_cost: z.union([z.number(), z.string(), z.null()]).optional(),
    unit: z.string().optional(),
    quantity: z.number().optional(),
    price: z.number().optional(),
  })
  .passthrough();

const LineInput = z
  .object({
    id: z.string().optional(),
    source: z
      .enum([
        'normalized',
        'infracost',
        'terraform-plan',
        'kubernetes',
        'kubecost',
        'aws-cost-explorer',
        'azure-cost-management',
        'gcp-bigquery-billing',
      ])
      .optional(),
    service: z.string().min(1),
    resource_type: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    environment: z.enum(['production', 'staging', 'development', 'sandbox', 'other']).optional(),
    change: z.enum(['create', 'update', 'delete', 'baseline', 'forecast']).optional(),
    monthly_cost: z.union([z.number(), z.string(), z.null()]).optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    partial: z.boolean().optional(),
    normalization: z.enum(['monthly', 'calendar-month', 'window-scaled', 'unit-price']).optional(),
    components: z.array(ComponentInput).optional(),
  })
  .passthrough();

const FileSchema = z
  .object({
    version: z.number().int().positive().optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    environment: z.enum(['production', 'staging', 'development', 'sandbox', 'other']).optional(),
    baseline_monthly: z.union([z.number(), z.string()]).optional(),
    lines: z.array(LineInput).max(5_000).optional(),
  })
  .passthrough();

export interface NormalizedParseOptions {
  environment: EnvironmentName;
  currency: string;
  text?: string;
  document?: unknown;
}

export function parseNormalizedDocument(options: NormalizedParseOptions): CollectResult {
  const document = options.document ?? parseYamlOrJson(options.text ?? '', 'normalized estimates');
  const file = FileSchema.parse(document);
  const currency = (file.currency ?? options.currency).toUpperCase();
  const environment = file.environment ?? options.environment;
  const warnings: string[] = [];
  const lines: CostLine[] = [];

  for (const [index, raw] of (file.lines ?? []).entries()) {
    const address = raw.address ?? raw.id ?? `${raw.service}-${index + 1}`;
    const monthly = raw.monthly_cost === undefined ? null : parseCost(raw.monthly_cost);
    lines.push(
      makeLine({
        source: raw.source ?? 'normalized',
        service: raw.service,
        resource_type: raw.resource_type ?? raw.service,
        address,
        environment: raw.environment ?? environment,
        change: raw.change ?? 'create',
        monthly_cost: monthly,
        currency: (raw.currency ?? currency).toUpperCase(),
        normalization: raw.normalization ?? 'monthly',
        partial: raw.partial ?? false,
        components: (raw.components ?? []).map(component => ({
          name: component.name,
          monthly_cost: component.monthly_cost == null ? null : parseCost(component.monthly_cost),
          unit: component.unit,
          quantity: component.quantity,
          price: component.price,
        })),
      }),
    );
  }

  const baseline = parseCost(file.baseline_monthly);
  if (baseline != null) {
    lines.push(
      makeLine({
        source: 'normalized',
        service: 'baseline',
        resource_type: 'baseline',
        address: 'baseline',
        environment,
        change: 'baseline',
        monthly_cost: baseline,
        currency,
        normalization: 'monthly',
      }),
    );
  }

  if (!lines.length) {
    throw new Error('Normalized estimates contain no cost lines or baseline');
  }
  if ((file.lines?.length ?? 0) > 5_000) {
    throw new Error('Refusing to truncate normalized cost lines');
  }
  return { lines, warnings };
}
