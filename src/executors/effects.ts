import type { CostDecision } from '../schemas/decision.js';
import type { PolicyOutcome } from '../decision/policy.js';
import { escapeCell } from '../utils/sanitize.js';

export const COMMENT_MARKER = '<!-- jev-cloud-cost-guardian -->';

export const ALLOWED_EFFECTS = [
  'set-outputs',
  'write-summary',
  'pull-request-comment',
  'fail-workflow',
] as const;
export type AllowedEffect = (typeof ALLOWED_EFFECTS)[number];

export function effectsFor(outcome: PolicyOutcome, comment: boolean): AllowedEffect[] {
  const effects: AllowedEffect[] = ['set-outputs', 'write-summary'];
  if (comment) effects.push('pull-request-comment');
  if (outcome.status === 'fail') effects.push('fail-workflow');
  return effects;
}

export function renderSummaryMarkdown(decision: CostDecision): string {
  const header = [
    COMMENT_MARKER,
    '## JEV Cloud Cost Guardian',
    '',
    `- Decision: \`${decision.decision}\``,
    `- Confidence: ${decision.confidence.toFixed(3)}`,
    `- Provisional: ${decision.provisional ? 'yes' : 'no'}`,
    `- Currency: ${decision.currency}`,
    `- Baseline monthly: ${money(decision.baseline_monthly)}`,
    `- Delta monthly: ${decision.delta_monthly.toFixed(2)}`,
    `- Projected monthly: ${money(decision.projected_monthly)}`,
    `- Budget monthly: ${decision.budget_monthly.toFixed(2)}`,
    `- Budget remaining: ${money(decision.budget_remaining)}`,
    `- Utilization: ${decision.utilization == null ? 'n/a' : decision.utilization.toFixed(4)}`,
    `- Unpriced lines: ${decision.unpriced_count}`,
    `- Reason codes: ${decision.reason_codes.map(code => `\`${code}\``).join(', ')}`,
    '',
    decision.explanation,
    '',
    '| Source | Service | Change | Monthly | Unpriced |',
    '| --- | --- | --- | --- | --- |',
  ];
  const rows = decision.findings.slice(0, 100).map(line => {
    const monthly = line.monthly_cost == null ? '' : line.monthly_cost.toFixed(2);
    return `| ${escapeCell(line.source)} | ${escapeCell(line.service)} | ${line.change} | ${monthly} | ${line.unpriced ? 'yes' : 'no'} |`;
  });
  if (decision.findings.length > 100) {
    rows.push(`| | | | | ${decision.findings.length - 100} more lines are in the findings output |`);
  }
  header.push(...rows);
  header.push('', 'Costs are never omitted. This action does not apply infrastructure changes.');
  return header.join('\n');
}

function money(value: number | null): string {
  return value == null ? 'unknown' : value.toFixed(2);
}

export interface CommentClient {
  listComments(): Promise<Array<{ id: number; body: string }>>;
  createComment(body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
}

export async function maybePostComment(
  enabled: boolean,
  dryRun: boolean,
  decision: CostDecision,
  client: CommentClient | null,
): Promise<'posted' | 'updated' | 'dry-run' | 'skipped'> {
  if (!enabled) return 'skipped';
  const body = renderSummaryMarkdown(decision);
  if (dryRun || !client) return 'dry-run';
  const existing = await client.listComments();
  const match = existing.find(comment => comment.body.includes(COMMENT_MARKER));
  if (match) {
    await client.updateComment(match.id, body);
    return 'updated';
  }
  await client.createComment(body);
  return 'posted';
}
