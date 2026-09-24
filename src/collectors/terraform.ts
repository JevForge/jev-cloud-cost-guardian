import { z } from 'zod';
import type { EnvironmentName } from '../schemas/enums.js';
import type { CostLine } from '../schemas/cost.js';
import { parseYamlOrJson } from '../utils/fs.js';
import { makeLine } from './line.js';
import type { CollectResult } from './types.js';

const RuleSchema = z
  .object({
    type: z.string().min(1),
    monthly_cost: z.number().finite(),
    when: z.record(z.string()).optional(),
  })
  .strict();

const CatalogSchema = z
  .object({
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    rules: z.array(RuleSchema).default([]),
  })
  .strict();

export interface PriceRule {
  type: string;
  monthly_cost: number;
  when?: Record<string, string>;
}

export interface PricingCatalog {
  currency: string;
  rules: PriceRule[];
}

interface TfResourceChange {
  address?: string;
  mode?: string;
  type?: string;
  change?: {
    actions?: string[];
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
}

const SENSITIVE_KEY = /password|secret|token|credential|private_key|user_data/i;

export function parsePricingCatalog(document: unknown, fallbackCurrency: string): PricingCatalog {
  const parsed = CatalogSchema.parse(document ?? { rules: [] });
  return {
    currency: (parsed.currency ?? fallbackCurrency).toUpperCase(),
    rules: parsed.rules,
  };
}

export function parsePricingCatalogText(text: string, fallbackCurrency: string): PricingCatalog {
  return parsePricingCatalog(parseYamlOrJson(text, 'pricing catalog'), fallbackCurrency);
}

function publicAttrs(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    out[key] = entry;
  }
  return out;
}

function ruleScore(rule: PriceRule, resourceType: string, attrs: Record<string, unknown>): number | null {
  if (rule.type !== resourceType) return null;
  const when = rule.when ?? {};
  for (const [key, expected] of Object.entries(when)) {
    if (String(attrs[key] ?? '') !== expected) return null;
  }
  return Object.keys(when).length;
}

export function priceFor(
  catalog: PricingCatalog,
  resourceType: string,
  attrs: Record<string, unknown> | null | undefined,
): number | null {
  let best: { score: number; cost: number } | null = null;
  for (const rule of catalog.rules) {
    const score = ruleScore(rule, resourceType, publicAttrs(attrs));
    if (score == null) continue;
    if (!best || score > best.score) best = { score, cost: rule.monthly_cost };
  }
  return best?.cost ?? null;
}

function changeKind(actions: string[] | undefined): 'create' | 'update' | 'delete' | 'skip' {
  const kinds = new Set(actions ?? []);
  if (kinds.has('create') && kinds.has('delete')) return 'update';
  if (kinds.has('create')) return 'create';
  if (kinds.has('delete')) return 'delete';
  if (kinds.has('update')) return 'update';
  return 'skip';
}

export function parseTerraformPlan(
  document: unknown,
  catalog: PricingCatalog,
  environment: EnvironmentName,
): CollectResult {
  const plan = (document ?? {}) as { resource_changes?: TfResourceChange[] };
  const lines: CostLine[] = [];
  const warnings: string[] = [];

  for (const resource of plan.resource_changes ?? []) {
    if (resource.mode && resource.mode !== 'managed') continue;
    const kind = changeKind(resource.change?.actions);
    if (kind === 'skip') continue;
    const type = resource.type || 'unknown';
    const address = resource.address || type;
    const before = priceFor(catalog, type, resource.change?.before);
    const after = priceFor(catalog, type, resource.change?.after);

    let monthly: number | null = null;
    let detail: CostLine['detail_code'];
    let partial = false;
    if (kind === 'create') {
      monthly = after;
      if (after == null) detail = 'NO_MATCHING_PRICE';
    } else if (kind === 'delete') {
      monthly = before == null ? null : -before;
      if (before == null) detail = 'NO_MATCHING_PRICE';
    } else if (before == null || after == null) {
      monthly = null;
      partial = true;
      detail = 'UPDATE_PRICE_INCOMPLETE';
    } else {
      monthly = after - before;
    }

    lines.push(
      makeLine({
        source: 'terraform-plan',
        service: type,
        resource_type: type,
        address,
        environment,
        change: kind,
        monthly_cost: monthly,
        currency: catalog.currency,
        normalization: 'monthly',
        partial,
        detail_code: detail,
      }),
    );
  }

  if (!lines.length) {
    warnings.push('Terraform plan contained no managed create, update, or delete changes');
  }
  if (lines.length > 5_000) {
    throw new Error(`Refusing to truncate ${lines.length} Terraform cost lines`);
  }
  return { lines, warnings };
}

export function parseTerraformPlanText(
  text: string,
  catalog: PricingCatalog,
  environment: EnvironmentName,
): CollectResult {
  return parseTerraformPlan(parseYamlOrJson(text, 'terraform plan'), catalog, environment);
}
