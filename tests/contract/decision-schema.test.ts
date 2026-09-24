import { describe, expect, it } from 'vitest';
import { CostDecisionSchema } from '../../src/schemas/decision.js';
import { line, report } from '../helpers.js';
import { normalizeAnswer } from '../../src/jev/normalize.js';

const base = report([
  line({ address: 'baseline', monthly_cost: 800, change: 'baseline', service: 'baseline', resource_type: 'baseline' }),
  line({ address: 'aws_instance.web', monthly_cost: 50, service: 'Amazon EC2', resource_type: 'aws_instance' }),
]);

describe('cost decision schema', () => {
  it('accepts a complete decision and keeps every finding', () => {
    const decision = normalizeAnswer({ decision: 'warn', confidence: 0.82, provisional: false }, base);
    expect(CostDecisionSchema.parse(decision).decision).toBe('warn');
    expect(decision.findings).toHaveLength(2);
    expect(decision.reason_codes).toContain('APPROACHING_BUDGET');
    expect(decision.projected_monthly).toBe(850);
    expect(decision.budget_remaining).toBe(150);
  });

  it.each([
    [{ decision: 'approve', confidence: 1.2, reason_codes: ['WITHIN_BUDGET'] }, 'confidence'],
    [{ decision: 'terraform apply', confidence: 0.9, reason_codes: ['WITHIN_BUDGET'] }, 'decision'],
    [{ decision: 'approve', confidence: 0.9, reason_codes: [] }, 'reason'],
    [{ decision: 'approve', confidence: -0.1, reason_codes: ['WITHIN_BUDGET'] }, 'confidence'],
    [{ decision: 'approve', confidence: 0.9, reason_codes: ['DROP_ALL_COSTS'] }, 'reason'],
    [
      {
        decision: 'block',
        confidence: 0.4,
        reason_codes: ['EXCEEDS_BUDGET'],
        shell: 'terraform apply',
      },
      'shell',
    ],
  ])('rejects %j', (payload) => {
    expect(CostDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a choice outside the decision enum before it can be executed', () => {
    expect(() =>
      normalizeAnswer({ decision: 'terraform apply -auto-approve', confidence: 0.99, provisional: false }, base),
    ).toThrow(/SCHEMA_REJECTED/);
  });
});
