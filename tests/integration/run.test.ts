import { describe, expect, it } from 'vitest';
import { runCostGuardian } from '../../src/run.js';
import type { JevProvider } from '../../src/jev/types.js';
import { line, policyDefaults, report } from '../helpers.js';

const within = report([
  line({ address: 'baseline', monthly_cost: 400, change: 'baseline', service: 'baseline', resource_type: 'baseline' }),
  line({ address: 'aws_instance.web', monthly_cost: 40, service: 'Amazon EC2', resource_type: 'aws_instance' }),
]);

function provider(decision: string, confidence = 0.92, incompleteProbability = 0.1): JevProvider {
  return {
    id: 'custom-compatible',
    async evaluateCost() {
      return { decision, confidence, provisional: false, incompleteProbability };
    },
  };
}

describe('runCostGuardian', () => {
  it('returns the Jev decision when the budget and estimates allow it', async () => {
    const result = await runCostGuardian({
      report: within,
      ...policyDefaults,
      jevProvider: 'custom-compatible',
      timeoutMs: 1000,
      redactResourceNames: true,
      commentOnGithub: false,
      dryRun: true,
      provider: provider('approve'),
    });
    expect(result.outcome.decision.decision).toBe('approve');
    expect(result.outcome.decision.findings[1]?.address.startsWith('redacted:')).toBe(true);
    expect(result.outcome.decision.findings[1]?.monthly_cost).toBe(40);
    expect(result.effects).toEqual(['set-outputs', 'write-summary']);
    expect(result.commentStatus).toBe('skipped');
  });

  it('moves an incomplete approve from Jev into manual review', async () => {
    const result = await runCostGuardian({
      report: within,
      ...policyDefaults,
      lowConfidencePolicy: 'request-review',
      failOnBlock: false,
      jevProvider: 'custom-compatible',
      timeoutMs: 1000,
      redactResourceNames: false,
      commentOnGithub: true,
      dryRun: true,
      provider: provider('approve', 0.9, 0.8),
    });
    expect(result.outcome.decision.decision).toBe('manual-review');
    expect(result.outcome.decision.reason_codes).toContain('UNCERTAIN_ESTIMATE');
    expect(result.commentStatus).toBe('dry-run');
    expect(result.effects).not.toContain('fail-workflow');
  });
});
