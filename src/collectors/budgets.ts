import { z } from 'zod';
import { ENVIRONMENTS, type EnvironmentName } from '../schemas/enums.js';
import type { CostLine } from '../schemas/cost.js';

export const BudgetRuleSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    monthly: z.number().finite().nonnegative(),
    environment: z.enum(ENVIRONMENTS).optional(),
    path: z.string().min(1).max(256).optional(),
    service: z.string().min(1).max(128).optional(),
  })
  .strict();

export type BudgetRule = z.infer<typeof BudgetRuleSchema>;

export interface ResolvedBudget {
  monthly: number;
  rule_name: string | null;
  matched: boolean;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function scoreRule(rule: BudgetRule, environment: EnvironmentName, lines: CostLine[]): number | null {
  let score = 0;
  if (rule.environment) {
    if (rule.environment !== environment) return null;
    score += 4;
  }
  if (rule.service) {
    const service = rule.service.toLowerCase();
    if (!lines.some(line => line.service.toLowerCase() === service || line.resource_type.toLowerCase() === service)) {
      return null;
    }
    score += 2;
  }
  if (rule.path) {
    const re = globToRegExp(rule.path);
    if (!lines.some(line => re.test(line.address))) return null;
    score += 3;
  }
  return score;
}

/**
 * Pick the most specific matching budget rule. Ties keep the first highest score.
 * Falls back to `fallbackMonthly` when no rule matches.
 */
export function resolveBudget(
  environment: EnvironmentName,
  lines: CostLine[],
  rules: BudgetRule[] | undefined,
  fallbackMonthly: number,
): ResolvedBudget {
  if (!rules?.length) {
    return { monthly: fallbackMonthly, rule_name: null, matched: false };
  }
  let best: { score: number; rule: BudgetRule } | null = null;
  for (const rule of rules) {
    const score = scoreRule(rule, environment, lines);
    if (score == null) continue;
    if (!best || score > best.score) best = { score, rule };
  }
  if (!best) return { monthly: fallbackMonthly, rule_name: null, matched: false };
  return {
    monthly: best.rule.monthly,
    rule_name: best.rule.name ?? 'matched-rule',
    matched: true,
  };
}
