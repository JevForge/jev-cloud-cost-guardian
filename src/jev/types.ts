import type { JevProviderId } from '../schemas/enums.js';
import type { CostDecision } from '../schemas/decision.js';
import type { CostReport } from '../collectors/aggregate.js';

export interface CostEvaluationState {
  currency: string;
  environment: string;
  window: { start: string; end: string };
  budget_monthly: number;
  budget_scope: string;
  warn_utilization: number;
  block_utilization: number;
  baseline_monthly: number | null;
  delta_monthly: number;
  projected_monthly: number | null;
  scope_monthly: number | null;
  utilization: number | null;
  budget_remaining: number | null;
  baseline_known: boolean;
  unpriced_count: number;
  partial_count: number;
  sources: string[];
  warnings: string[];
  lines: Array<{
    source: string;
    service: string;
    resource_type: string;
    address: string;
    change: string;
    monthly_cost: number | null;
    currency: string;
    unpriced: boolean;
    partial: boolean;
    normalization: string;
    detail_code?: string;
    components: Array<{ name: string; monthly_cost: number | null }>;
  }>;
  note: string;
}

export interface JevRawAnswer {
  decision: string | null;
  confidence: number;
  incompleteProbability?: number;
  provisional: boolean;
  unavailableMessage?: string;
}

export interface JevProvider {
  readonly id: JevProviderId;
  evaluateCost(state: CostEvaluationState): Promise<JevRawAnswer>;
}

export interface JevProviderOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface NormalizedEvaluation {
  decision: CostDecision;
  report: CostReport;
}
