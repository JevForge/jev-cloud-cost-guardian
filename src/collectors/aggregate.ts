import {
  BILLING_SOURCES,
  PLAN_SOURCES,
  type BudgetScope,
  type CostSource,
  type EnvironmentName,
} from '../schemas/enums.js';
import type { CostLine } from '../schemas/cost.js';
import { convertCurrency, roundMoney } from '../utils/money.js';
import { uniq } from '../utils/fs.js';

const DELTA_CHANGES = new Set(['create', 'update', 'delete']);

export interface AggregateInput {
  lines: CostLine[];
  warnings: string[];
  currency: string;
  environment: EnvironmentName;
  window: { start: string; end: string };
  budget_monthly: number;
  warn_utilization: number;
  block_utilization: number;
  budget_scope: BudgetScope;
  fx_rates: Record<string, number>;
  budget_rule_name?: string | null;
}

export interface CostReport {
  currency: string;
  environment: EnvironmentName;
  window: { start: string; end: string };
  lines: CostLine[];
  baseline_monthly: number | null;
  delta_monthly: number;
  projected_monthly: number | null;
  scope_monthly: number | null;
  budget_monthly: number;
  budget_remaining: number | null;
  utilization: number | null;
  warn_utilization: number;
  block_utilization: number;
  budget_scope: BudgetScope;
  budget_rule_name: string | null;
  baseline_origin: 'explicit' | 'billing' | 'estimate' | null;
  unpriced_count: number;
  partial_count: number;
  sources: CostSource[];
  baseline_known: boolean;
  converted: boolean;
  warnings: string[];
}

function preferPlanLine(current: CostLine, incoming: CostLine): CostLine {
  if (current.unpriced && !incoming.unpriced) return incoming;
  if (!current.unpriced && incoming.unpriced) return current;
  const rank = (source: CostSource) => (source === 'infracost' ? 3 : source === 'terraform-plan' ? 2 : 1);
  return rank(incoming.source) > rank(current.source) ? incoming : current;
}

function convertLine(line: CostLine, currency: string, rates: Record<string, number>): { line: CostLine; converted: boolean } {
  if (line.monthly_cost == null || line.currency === currency) {
    return { line: { ...line, currency: line.monthly_cost == null ? currency : line.currency }, converted: false };
  }
  const fx = convertCurrency(line.monthly_cost, line.currency, currency, rates);
  return {
    converted: true,
    line: {
      ...line,
      currency,
      monthly_cost: fx.amount,
      source_monthly_cost: line.source_monthly_cost ?? fx.sourceAmount,
      source_currency: line.source_currency ?? fx.sourceCurrency,
      components: line.components.map(component => ({
        ...component,
        monthly_cost:
          component.monthly_cost == null
            ? null
            : convertCurrency(component.monthly_cost, line.currency, currency, rates).amount,
      })),
    },
  };
}

export function aggregateCosts(input: AggregateInput): CostReport {
  if (input.block_utilization < input.warn_utilization) {
    throw new Error('block_utilization must be greater than or equal to warn_utilization');
  }
  const warnings = [...input.warnings];
  let converted = false;
  const convertedLines = input.lines.map(line => {
    const result = convertLine(line, input.currency, input.fx_rates);
    converted = converted || result.converted;
    return result.line;
  });

  const billingBaselines = convertedLines.filter(
    line => line.change === 'baseline' && BILLING_SOURCES.includes(line.source),
  );
  const kept: CostLine[] = [];
  for (const line of convertedLines) {
    if (
      billingBaselines.length > 0 &&
      line.change === 'baseline' &&
      line.source === 'normalized' &&
      line.address === 'baseline'
    ) {
      warnings.push(
        `Ignoring normalized baseline ${line.monthly_cost ?? 'unpriced'} ${input.currency} because cloud billing baselines are present.`,
      );
      continue;
    }
    kept.push(line);
  }

  const planDeltas = new Map<string, CostLine>();
  const passthrough: CostLine[] = [];
  for (const line of kept) {
    const isPlanDelta = PLAN_SOURCES.includes(line.source) && DELTA_CHANGES.has(line.change);
    if (!isPlanDelta) {
      passthrough.push(line);
      continue;
    }
    const key = line.address;
    const existing = planDeltas.get(key);
    planDeltas.set(key, existing ? preferPlanLine(existing, line) : line);
  }
  const lines = [...passthrough, ...planDeltas.values()];

  const sources = uniq(lines.map(line => line.source));
  if (sources.includes('kubecost') && sources.some(source => BILLING_SOURCES.includes(source))) {
    warnings.push(
      'Kubecost baseline is summed with cloud billing. Omit one source when the cluster is already included in the cloud bill.',
    );
  }
  if (sources.includes('kubernetes') && sources.includes('kubecost')) {
    warnings.push(
      'Kubernetes manifest estimates are treated as proposed deltas on top of Kubecost baseline. Do not pass both for the same already-running pods.',
    );
  }

  const baselineLines = lines.filter(line => line.change === 'baseline' && line.monthly_cost != null);
  const explicitBaselines = baselineLines.filter(line => line.address.startsWith('baseline:explicit'));
  const billingBaselineLines = baselineLines.filter(line => BILLING_SOURCES.includes(line.source));
  const estimateBaselines = baselineLines.filter(
    line => !line.address.startsWith('baseline:explicit') && !BILLING_SOURCES.includes(line.source),
  );
  let effectiveBaselines = baselineLines;
  let baseline_origin: CostReport['baseline_origin'] = null;
  if (explicitBaselines.length) {
    effectiveBaselines = explicitBaselines;
    baseline_origin = 'explicit';
    if (billingBaselineLines.length || estimateBaselines.length) {
      warnings.push('Explicit baseline_path supersedes other baseline sources for the budget comparison.');
    }
  } else if (billingBaselineLines.length) {
    baseline_origin = 'billing';
  } else if (estimateBaselines.length) {
    baseline_origin = 'estimate';
  }
  const baseline_known = effectiveBaselines.length > 0;
  const baseline_monthly = baseline_known
    ? roundMoney(effectiveBaselines.reduce((sum, line) => sum + (line.monthly_cost ?? 0), 0))
    : null;
  const delta_monthly = roundMoney(
    lines
      .filter(line => DELTA_CHANGES.has(line.change) && line.monthly_cost != null)
      .reduce((sum, line) => sum + (line.monthly_cost ?? 0), 0),
  );
  const projected_monthly = baseline_known ? roundMoney((baseline_monthly ?? 0) + delta_monthly) : null;
  const scope_monthly = input.budget_scope === 'delta' ? delta_monthly : projected_monthly;
  const budget_remaining = scope_monthly == null ? null : roundMoney(input.budget_monthly - scope_monthly);
  let utilization: number | null = null;
  if (scope_monthly != null && input.budget_monthly > 0) {
    utilization = roundMoney(scope_monthly / input.budget_monthly);
  } else if (scope_monthly != null && input.budget_monthly === 0) {
    utilization = scope_monthly <= 0 ? 0 : null;
  }

  return {
    currency: input.currency,
    environment: input.environment,
    window: input.window,
    lines,
    baseline_monthly,
    delta_monthly,
    projected_monthly,
    scope_monthly,
    budget_monthly: input.budget_monthly,
    budget_remaining,
    utilization,
    warn_utilization: input.warn_utilization,
    block_utilization: input.block_utilization,
    budget_scope: input.budget_scope,
    budget_rule_name: input.budget_rule_name ?? null,
    unpriced_count: lines.filter(line => line.unpriced).length,
    partial_count: lines.filter(line => line.partial).length,
    sources,
    baseline_known,
    baseline_origin,
    converted,
    warnings,
  };
}
