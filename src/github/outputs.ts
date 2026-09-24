import type { CostDecision } from '../schemas/decision.js';
import type { PolicyOutcome } from '../decision/policy.js';

export interface ActionOutputWriter {
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  warning(message: string): void;
  info(message: string): void;
  summary(markdown: string): Promise<void> | void;
}

export function writeDecisionOutputs(writer: ActionOutputWriter, decision: CostDecision): void {
  writer.setOutput('decision', decision.decision);
  writer.setOutput('blocked', decision.decision === 'block' ? 'true' : 'false');
  writer.setOutput('confidence', String(decision.confidence));
  writer.setOutput('reason_codes', JSON.stringify(decision.reason_codes));
  writer.setOutput('estimated_monthly_impact', String(decision.delta_monthly));
  writer.setOutput('baseline_monthly', decision.baseline_monthly == null ? '' : String(decision.baseline_monthly));
  writer.setOutput('projected_monthly', decision.projected_monthly == null ? '' : String(decision.projected_monthly));
  writer.setOutput('budget_monthly', String(decision.budget_monthly));
  writer.setOutput('budget_rule', decision.budget_rule ?? '');
  writer.setOutput('budget_remaining', decision.budget_remaining == null ? '' : String(decision.budget_remaining));
  writer.setOutput('utilization', decision.utilization == null ? '' : String(decision.utilization));
  writer.setOutput('currency', decision.currency);
  writer.setOutput('summary', decision.summary);
  writer.setOutput('explanation', decision.explanation);
  writer.setOutput('provisional', String(decision.provisional));
  writer.setOutput('findings', JSON.stringify(decision.findings));
  writer.setOutput('sources', JSON.stringify(decision.sources));
  writer.setOutput('unpriced_count', String(decision.unpriced_count));
}

export async function applyOutcome(
  writer: ActionOutputWriter,
  outcome: PolicyOutcome,
  markdown: string,
): Promise<void> {
  writeDecisionOutputs(writer, outcome.decision);
  await writer.summary(markdown);
  if (outcome.status === 'fail') {
    writer.setFailed(outcome.message);
    return;
  }
  if (outcome.status === 'warn' || outcome.status === 'manual-review') {
    writer.warning(outcome.message);
    return;
  }
  if (outcome.status === 'no-op') writer.info(outcome.message);
}
