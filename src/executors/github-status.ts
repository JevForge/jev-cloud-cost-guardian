import type { CostDecision } from '../schemas/decision.js';
import type { PolicyOutcome } from '../decision/policy.js';

export const COST_DECISION_LABEL_PREFIX = 'jev:cost:decision:';
export const COST_REVIEW_LABEL = 'jev:cost:review';

export function decisionLabel(decision: CostDecision['decision']): string {
  return `${COST_DECISION_LABEL_PREFIX}${decision}`;
}

export function desiredLabels(decision: CostDecision): string[] {
  const labels = [decisionLabel(decision.decision)];
  if (decision.decision === 'manual-review') labels.push(COST_REVIEW_LABEL);
  return labels;
}

export function isManagedCostLabel(name: string): boolean {
  return name.startsWith(COST_DECISION_LABEL_PREFIX) || name === COST_REVIEW_LABEL;
}

export interface LabelClient {
  listLabels(): Promise<string[]>;
  ensureLabel(name: string): Promise<void>;
  setLabels(next: string[]): Promise<void>;
}

/**
 * Replace managed `jev:cost:*` labels while preserving unrelated labels.
 */
export async function applyCostLabels(
  enabled: boolean,
  dryRun: boolean,
  decision: CostDecision,
  client: LabelClient | null,
): Promise<'applied' | 'dry-run' | 'skipped'> {
  if (!enabled) return 'skipped';
  if (dryRun || !client) return 'dry-run';

  const current = await client.listLabels();
  const preserved = current.filter(name => !isManagedCostLabel(name));
  const wanted = desiredLabels(decision);
  const next = [...new Set([...preserved, ...wanted])];

  for (const name of wanted) {
    await client.ensureLabel(name);
  }
  await client.setLabels(next);
  return 'applied';
}

export function checkConclusion(outcome: PolicyOutcome): 'success' | 'neutral' | 'failure' {
  if (outcome.status === 'ok') return 'success';
  if (outcome.status === 'fail') return 'failure';
  return 'neutral';
}

export function buildCheckSummary(outcome: PolicyOutcome): string {
  const d = outcome.decision;
  return [
    '### JEV Cloud Cost Guardian',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Decision | \`${d.decision}\` |`,
    `| Confidence | ${d.confidence.toFixed(3)} |`,
    `| Policy | \`${outcome.status}\` |`,
    `| Projected monthly | \`${d.projected_monthly == null ? 'unknown' : d.projected_monthly.toFixed(2)}\` |`,
    `| Delta monthly | \`${d.delta_monthly.toFixed(2)}\` |`,
    `| Budget monthly | \`${d.budget_monthly.toFixed(2)}\` |`,
    `| Utilization | \`${d.utilization == null ? 'n/a' : d.utilization.toFixed(4)}\` |`,
    `| Unpriced | \`${d.unpriced_count}\` |`,
    `| Reason codes | ${d.reason_codes.map(code => `\`${code}\``).join(', ')} |`,
    '',
    d.explanation || '_No explanation._',
  ].join('\n');
}

export interface CheckRunClient {
  createCheckRun(input: {
    name: string;
    headSha: string;
    conclusion: 'success' | 'neutral' | 'failure';
    title: string;
    summary: string;
  }): Promise<void>;
}

export async function maybeCreateCheckRun(
  enabled: boolean,
  dryRun: boolean,
  headSha: string | null,
  outcome: PolicyOutcome,
  client: CheckRunClient | null,
): Promise<'created' | 'dry-run' | 'skipped'> {
  if (!enabled) return 'skipped';
  if (!headSha) return 'skipped';
  if (dryRun || !client) return 'dry-run';

  await client.createCheckRun({
    name: 'JEV Cloud Cost Guardian',
    headSha,
    conclusion: checkConclusion(outcome),
    title: outcome.decision.decision,
    summary: buildCheckSummary(outcome),
  });
  return 'created';
}
