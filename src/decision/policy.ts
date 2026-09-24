import type { Decision, ReasonCode } from '../schemas/enums.js';
import { CostDecisionSchema, type CostDecision } from '../schemas/decision.js';
import type { LowConfidencePolicy } from '../schemas/enums.js';
import type { CostReport } from '../collectors/aggregate.js';
import { buildExplanation, buildSummary } from '../jev/normalize.js';

export type PolicyOutcome =
  | { status: 'ok'; decision: CostDecision }
  | { status: 'warn'; decision: CostDecision; message: string }
  | { status: 'manual-review'; decision: CostDecision; message: string }
  | { status: 'no-op'; decision: CostDecision; message: string }
  | { status: 'fail'; decision: CostDecision; message: string };

export interface PolicyOptions {
  minConfidence: number;
  lowConfidencePolicy: LowConfidencePolicy;
  enforceBlockThreshold: boolean;
  allowUnpriced: boolean;
  allowPartial: boolean;
  allowMissingBaseline: boolean;
  failOnBlock: boolean;
  failOnManualReview: boolean;
  failOnWarn?: boolean;
  warnDeltaPct?: number | null;
  blockDeltaPct?: number | null;
}

function overBlockThreshold(report: CostReport): boolean {
  if (report.scope_monthly == null) return false;
  if (report.budget_monthly === 0) return report.scope_monthly > 0;
  return report.scope_monthly >= report.budget_monthly * report.block_utilization;
}

function deltaRatio(report: CostReport): number | null {
  if (!report.baseline_known || report.baseline_monthly == null) return null;
  const baseline = Math.abs(report.baseline_monthly);
  if (baseline === 0) return report.delta_monthly === 0 ? 0 : null;
  return report.delta_monthly / baseline;
}

function withDecision(decision: CostDecision, next: Decision, report: CostReport, reasons: Set<ReasonCode>): CostDecision {
  const reason_codes = [...reasons].slice(0, 24);
  return {
    ...decision,
    decision: next,
    reason_codes,
    summary: buildSummary(next, report, decision.confidence),
    explanation: buildExplanation(next, report, decision.provisional),
  };
}

export function applyCostPolicy(decision: CostDecision, report: CostReport, options: PolicyOptions): PolicyOutcome {
  const parsed = CostDecisionSchema.parse(decision);
  const reasons = new Set<ReasonCode>(parsed.reason_codes);
  let current: CostDecision = {
    ...parsed,
    findings: report.lines,
  };
  if (parsed.findings.length !== report.lines.length || parsed.findings.some((line, index) => line.id !== report.lines[index]?.id)) {
    reasons.add('COST_VISIBILITY_ENFORCED');
  }

  const unavailable = current.provisional || reasons.has('JEV_UNAVAILABLE');
  if (!unavailable) {
    if (!options.allowUnpriced && report.unpriced_count > 0 && current.decision === 'approve') {
      reasons.add('UNPRICED_RESOURCES');
      reasons.add('POLICY_MANUAL_REVIEW');
      current = withDecision(current, 'manual-review', report, reasons);
    }
    if (!options.allowPartial && report.partial_count > 0 && current.decision === 'approve') {
      reasons.add('UNCERTAIN_ESTIMATE');
      reasons.add('POLICY_MANUAL_REVIEW');
      current = withDecision(current, 'manual-review', report, reasons);
    }
    if (
      !options.allowMissingBaseline &&
      !report.baseline_known &&
      report.budget_scope === 'projected' &&
      current.decision === 'approve'
    ) {
      reasons.add('MISSING_BASELINE');
      reasons.add('POLICY_MANUAL_REVIEW');
      current = withDecision(current, 'manual-review', report, reasons);
    }
    if (current.confidence < options.minConfidence && current.decision === 'approve') {
      reasons.add('LOW_CONFIDENCE');
      reasons.add('POLICY_MANUAL_REVIEW');
      current = withDecision(current, 'manual-review', report, reasons);
    }
    if (options.enforceBlockThreshold && overBlockThreshold(report) && (current.decision === 'approve' || current.decision === 'warn')) {
      reasons.add('HARD_BLOCK_THRESHOLD');
      reasons.add('EXCEEDS_BUDGET');
      current = withDecision(current, 'block', report, reasons);
    }
    const ratio = deltaRatio(report);
    if (ratio != null) {
      if (
        options.blockDeltaPct != null &&
        ratio >= options.blockDeltaPct &&
        (current.decision === 'approve' || current.decision === 'warn')
      ) {
        reasons.add('DELTA_BLOCK');
        current = withDecision(current, 'block', report, reasons);
      } else if (
        options.warnDeltaPct != null &&
        ratio >= options.warnDeltaPct &&
        current.decision === 'approve'
      ) {
        reasons.add('DELTA_WARN');
        current = withDecision(current, 'warn', report, reasons);
      }
    }
    if (current.confidence < options.minConfidence) {
      reasons.add('LOW_CONFIDENCE');
      if (options.lowConfidencePolicy === 'request-review' && current.decision !== 'block') {
        reasons.add('POLICY_MANUAL_REVIEW');
        current = withDecision(current, 'manual-review', report, reasons);
      }
    }
  }

  current = CostDecisionSchema.parse({
    ...current,
    findings: report.lines,
    reason_codes: [...reasons].slice(0, 24),
  });

  const lowConfidence = current.confidence < options.minConfidence || current.provisional;
  if (lowConfidence && options.lowConfidencePolicy === 'fail') {
    return { status: 'fail', decision: current, message: current.summary };
  }
  if (current.decision === 'block') {
    return {
      status: options.failOnBlock ? 'fail' : 'warn',
      decision: current,
      message: current.summary,
    };
  }
  if (current.decision === 'manual-review' && options.failOnManualReview) {
    return { status: 'fail', decision: current, message: current.summary };
  }
  if (lowConfidence && options.lowConfidencePolicy === 'no-op') {
    return { status: 'no-op', decision: current, message: current.summary };
  }
  if (current.decision === 'warn' || (lowConfidence && options.lowConfidencePolicy === 'warn')) {
    return {
      status: options.failOnWarn ? 'fail' : 'warn',
      decision: current,
      message: current.summary,
    };
  }
  if (current.decision === 'manual-review' || (lowConfidence && options.lowConfidencePolicy === 'request-review')) {
    return { status: 'manual-review', decision: current, message: current.summary };
  }
  return { status: 'ok', decision: current };
}
