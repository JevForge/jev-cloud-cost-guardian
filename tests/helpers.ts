import { aggregateCosts, type AggregateInput, type CostReport } from '../src/collectors/aggregate.js';
import { makeLine, type LineDraft } from '../src/collectors/line.js';
import type { CostLine } from '../src/schemas/cost.js';

export function line(overrides: Partial<LineDraft> & Pick<LineDraft, 'address' | 'monthly_cost'>): CostLine {
  return makeLine({
    source: 'normalized',
    service: 'compute',
    resource_type: 'instance',
    environment: 'production',
    change: 'create',
    currency: 'USD',
    normalization: 'monthly',
    ...overrides,
  });
}

export function report(lines: CostLine[], overrides: Partial<AggregateInput> = {}): CostReport {
  return aggregateCosts({
    lines,
    warnings: [],
    currency: 'USD',
    environment: 'production',
    window: { start: '2026-09-01', end: '2026-10-01' },
    budget_monthly: 1000,
    warn_utilization: 0.8,
    block_utilization: 1,
    budget_scope: 'projected',
    fx_rates: {},
    ...overrides,
  });
}

export const policyDefaults = {
  minConfidence: 0.75,
  lowConfidencePolicy: 'fail' as const,
  enforceBlockThreshold: true,
  allowUnpriced: false,
  allowPartial: false,
  allowMissingBaseline: false,
  failOnBlock: true,
  failOnManualReview: false,
};
