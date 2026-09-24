import { DECISIONS, REASON_CODES, type Decision, type ReasonCode } from '../../schemas/enums.js';
import { CostDecisionSchema, type CostDecision } from '../../schemas/decision.js';
import type { CostReport } from '../../collectors/aggregate.js';
import { uniq } from '../../utils/fs.js';
import type { JevRawAnswer } from './types.js';

const DELTA_CHANGES = new Set(['create', 'update', 'delete']);

export function factualReasonCodes(report: CostReport): ReasonCode[] {
  const codes: ReasonCode[] = [];
  if (report.scope_monthly != null && report.budget_monthly > 0) {
    const utilization = report.scope_monthly / report.budget_monthly;
    if (utilization >= report.block_utilization) codes.push('EXCEEDS_BUDGET');
    else if (utilization >= report.warn_utilization) codes.push('APPROACHING_BUDGET');
    else codes.push('WITHIN_BUDGET');
  } else if ((report.scope_monthly ?? 0) > 0 && report.budget_monthly === 0) {
    codes.push('EXCEEDS_BUDGET');
  } else if (report.scope_monthly != null) {
    codes.push('WITHIN_BUDGET');
  }
  if (report.delta_monthly < 0) codes.push('SAVINGS');
  if (report.delta_monthly > 0) codes.push('NEW_SPEND');
  if (report.unpriced_count > 0) codes.push('UNPRICED_RESOURCES');
  if (!report.baseline_known) codes.push('MISSING_BASELINE');
  else if (report.baseline_origin === 'explicit') codes.push('EXPLICIT_BASELINE');
  else if (report.baseline_origin === 'billing') codes.push('BASELINE_FROM_BILLING');
  if (report.partial_count > 0) codes.push('UNCERTAIN_ESTIMATE');
  codes.push(report.environment === 'production' ? 'PROD_ENVIRONMENT' : 'NON_PROD_ENVIRONMENT');
  if (report.sources.some(source => source === 'aws-cost-explorer' || source === 'azure-cost-management' || source === 'gcp-bigquery-billing' || source === 'kubecost')) {
    codes.push('BILLING_ACTUAL');
  }
  if (report.sources.some(source => source !== 'aws-cost-explorer' && source !== 'azure-cost-management' && source !== 'gcp-bigquery-billing')) {
    codes.push('PLAN_DELTA');
  }
  if (report.lines.some(line => line.change === 'forecast')) codes.push('FORECAST_INFORMATIONAL');
  if (report.lines.some(line => line.detail_code === 'RESOURCE_EXCLUDED')) {
    codes.push('RESOURCE_FILTERED');
  }
  if (report.sources.length > 1) codes.push('MULTI_SOURCE');
  if (report.converted) codes.push('CURRENCY_CONVERTED');
  if (report.lines.some(line => line.normalization === 'window-scaled')) codes.push('WINDOW_SCALED');
  const deltas = report.lines.filter(line => DELTA_CHANGES.has(line.change) && line.monthly_cost != null);
  const magnitude = deltas.reduce((sum, line) => sum + Math.abs(line.monthly_cost ?? 0), 0);
  if (magnitude > 0 && deltas.some(line => Math.abs(line.monthly_cost ?? 0) / magnitude > 0.5)) {
    codes.push('HIGH_CONCENTRATION');
  }
  return uniq(codes).filter(code => (REASON_CODES as readonly string[]).includes(code));
}

export function buildSummary(decision: Decision, report: CostReport, confidence: number): string {
  const projected = report.projected_monthly == null ? 'unknown' : report.projected_monthly.toFixed(2);
  const utilization = report.utilization == null ? 'n/a' : `${(report.utilization * 100).toFixed(1)}%`;
  return `${decision}: projected ${projected} ${report.currency}/month, delta ${report.delta_monthly.toFixed(2)}, budget ${report.budget_monthly.toFixed(2)} (${utilization}), confidence ${confidence.toFixed(3)}`.slice(0, 500);
}

export function buildExplanation(decision: Decision, report: CostReport, provisional: boolean): string {
  const sentences = [
    `Jev decision is ${decision}.`,
    `Scoped ${report.budget_scope} cost is ${report.scope_monthly == null ? 'unknown' : report.scope_monthly.toFixed(2)} ${report.currency} against a budget of ${report.budget_monthly.toFixed(2)} ${report.currency}.`,
    `Baseline is ${report.baseline_monthly == null ? 'unknown' : report.baseline_monthly.toFixed(2)} and the proposed delta is ${report.delta_monthly.toFixed(2)}.`,
    `${report.lines.length} cost lines remain visible (${report.unpriced_count} unpriced, ${report.partial_count} partial).`,
  ];
  if (report.warnings.length) sentences.push(report.warnings.join(' '));
  if (provisional) sentences.push('This decision is provisional because Jev did not return a usable typed answer.');
  return sentences.join(' ').slice(0, 2_000);
}

function asDecision(value: string | null): Decision {
  if (!value || !(DECISIONS as readonly string[]).includes(value)) {
    throw new Error('SCHEMA_REJECTED: decision is outside approve|warn|block|manual-review');
  }
  return value as Decision;
}

export function normalizeAnswer(answer: JevRawAnswer, report: CostReport): CostDecision {
  const reasons = new Set<ReasonCode>(factualReasonCodes(report));
  if (answer.unavailableMessage) {
    reasons.add('JEV_UNAVAILABLE');
    return CostDecisionSchema.parse({
      decision: 'manual-review',
      confidence: 0,
      reason_codes: [...reasons].slice(0, 24),
      currency: report.currency,
      environment: report.environment,
      window: report.window,
      baseline_monthly: report.baseline_monthly,
      delta_monthly: report.delta_monthly,
      projected_monthly: report.projected_monthly,
      budget_monthly: report.budget_monthly,
      budget_rule: report.budget_rule_name,
      budget_remaining: report.budget_remaining,
      utilization: report.utilization,
      summary: buildSummary('manual-review', report, 0),
      explanation: `${buildExplanation('manual-review', report, true)} ${answer.unavailableMessage}`.slice(0, 2_000),
      provisional: true,
      findings: report.lines,
      sources: report.sources,
      unpriced_count: report.unpriced_count,
      partial_count: report.partial_count,
    });
  }

  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw new Error('SCHEMA_REJECTED: confidence must be between 0 and 1');
  }
  let decision = asDecision(answer.decision);
  if ((answer.incompleteProbability ?? 0) >= 0.55 && decision === 'approve') {
    decision = 'manual-review';
    reasons.add('UNCERTAIN_ESTIMATE');
    reasons.add('POLICY_MANUAL_REVIEW');
  }
  const reason_codes = [...reasons].slice(0, 24);
  if (!reason_codes.length) reason_codes.push('UNCERTAIN_ESTIMATE');
  return CostDecisionSchema.parse({
    decision,
    confidence: answer.confidence,
    reason_codes,
    currency: report.currency,
    environment: report.environment,
    window: report.window,
    baseline_monthly: report.baseline_monthly,
    delta_monthly: report.delta_monthly,
    projected_monthly: report.projected_monthly,
    budget_monthly: report.budget_monthly,
    budget_rule: report.budget_rule_name,
    budget_remaining: report.budget_remaining,
    utilization: report.utilization,
    summary: buildSummary(decision, report, answer.confidence),
    explanation: buildExplanation(decision, report, false),
    provisional: answer.provisional,
    findings: report.lines,
    sources: report.sources,
    unpriced_count: report.unpriced_count,
    partial_count: report.partial_count,
  });
}
