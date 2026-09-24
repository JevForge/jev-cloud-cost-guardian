import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  BUDGET_SCOPES,
  ENVIRONMENTS,
  JEV_PROVIDERS,
  LOW_CONFIDENCE_POLICIES,
  type BudgetScope,
  type EnvironmentName,
  type JevProviderId,
  type LowConfidencePolicy,
} from '../schemas/enums.js';
import { parseYamlOrJson, readBounded } from '../utils/fs.js';
import { resolveInside } from '../utils/sanitize.js';

export const GuardianConfigSchema = z
  .object({
    jev_provider: z.enum(JEV_PROVIDERS).optional(),
    jev_endpoint: z.string().url().optional(),
    jev_model: z.string().min(1).optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    low_confidence_policy: z.enum(LOW_CONFIDENCE_POLICIES).optional(),
    budget_monthly: z.number().finite().nonnegative().optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    environment: z.enum(ENVIRONMENTS).optional(),
    window_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    window_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    warn_utilization: z.number().min(0).max(10).optional(),
    block_utilization: z.number().min(0).max(10).optional(),
    budget_scope: z.enum(BUDGET_SCOPES).optional(),
    enforce_block_threshold: z.boolean().optional(),
    allow_unpriced: z.boolean().optional(),
    allow_partial: z.boolean().optional(),
    allow_missing_baseline: z.boolean().optional(),
    normalize_to_monthly: z.boolean().optional(),
    comment_on_github: z.boolean().optional(),
    redact_resource_names: z.boolean().optional(),
    fail_on_block: z.boolean().optional(),
    fail_on_manual_review: z.boolean().optional(),
    include_aws_forecast: z.boolean().optional(),
    fx_rates: z.record(z.number().positive()).optional(),
    estimates_path: z.string().optional(),
    infracost_path: z.string().optional(),
    terraform_plan_path: z.string().optional(),
    pricing_catalog_path: z.string().optional(),
    kubernetes_paths: z.array(z.string()).optional(),
    k8s_unit_prices_path: z.string().optional(),
    kubecost_path: z.string().optional(),
  })
  .strict();

export type GuardianConfig = z.infer<typeof GuardianConfigSchema>;

export function loadGuardianConfig(workspace: string, relativePath = '.jev/config.yml'): GuardianConfig {
  const full = resolveInside(workspace, relativePath);
  if (!existsSync(full)) return {};
  return GuardianConfigSchema.parse(parseYamlOrJson(readBounded(full), relativePath) ?? {});
}

export function pickString(input: string | undefined, config: string | undefined, fallback?: string): string | undefined {
  const value = input?.trim() ? input.trim() : config ?? fallback;
  return value || undefined;
}

export function pickNumber(input: string | undefined, config: number | undefined, fallback: number): number {
  if (input?.trim()) return Number(input);
  return config ?? fallback;
}

export function pickBoolean(input: string | undefined, config: boolean | undefined, fallback: boolean): boolean {
  if (input?.trim()) {
    if (input !== 'true' && input !== 'false') throw new Error(`Expected true or false, received ${input}`);
    return input === 'true';
  }
  return config ?? fallback;
}

export function pickProvider(input: string | undefined, config: GuardianConfig): JevProviderId {
  const value = pickString(input, config.jev_provider, 'vercel-ai-gateway') as JevProviderId;
  if (!JEV_PROVIDERS.includes(value)) throw new Error(`Unsupported jev_provider: ${value}`);
  return value;
}

export function pickPolicy(input: string | undefined, config: GuardianConfig): LowConfidencePolicy {
  const value = pickString(input, config.low_confidence_policy, 'fail') as LowConfidencePolicy;
  if (!LOW_CONFIDENCE_POLICIES.includes(value)) throw new Error(`Unsupported low_confidence_policy: ${value}`);
  return value;
}

export function pickEnvironment(input: string | undefined, config: GuardianConfig): EnvironmentName {
  const value = pickString(input, config.environment, 'production') as EnvironmentName;
  if (!ENVIRONMENTS.includes(value)) throw new Error(`Unsupported environment: ${value}`);
  return value;
}

export function pickBudgetScope(input: string | undefined, config: GuardianConfig): BudgetScope {
  const value = pickString(input, config.budget_scope, 'projected') as BudgetScope;
  if (!BUDGET_SCOPES.includes(value)) throw new Error(`Unsupported budget_scope: ${value}`);
  return value;
}

export function splitPaths(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean);
}
