import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCostReport } from '../../src/collectors/load.js';
import { CostDecisionSchema } from '../../src/schemas/decision.js';
import { runCostGuardian } from '../../src/run.js';
import type { JevProvider } from '../../src/jev/types.js';
import { policyDefaults } from '../helpers.js';

const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), '../fixtures/golden');

const mockJev: JevProvider = {
  id: 'custom-compatible',
  async evaluateCost() {
    return { decision: 'warn', confidence: 0.88, provisional: false, incompleteProbability: 0.1 };
  },
};

describe('e2e smoke', () => {
  it('loads golden estimates, evaluates with a mock Jev provider, and keeps the decision contract', async () => {
    const report = await loadCostReport({
      workspace: fixtures,
      environment: 'production',
      currency: 'USD',
      window: { start: '2026-09-01', end: '2026-10-01' },
      normalizeToMonthly: false,
      budgetMonthly: 1000,
      warnUtilization: 0.8,
      blockUtilization: 1,
      budgetScope: 'projected',
      fxRates: {},
      estimatesPath: 'estimates.json',
      kubernetesPaths: [],
    });

    expect(report.baseline_monthly).toBe(800);
    expect(report.delta_monthly).toBe(42.5);
    expect(report.projected_monthly).toBe(842.5);
    expect(report.utilization).toBeCloseTo(0.8425, 4);

    const result = await runCostGuardian({
      report,
      ...policyDefaults,
      jevProvider: 'custom-compatible',
      timeoutMs: 1000,
      redactResourceNames: false,
      commentOnGithub: false,
      applyLabels: false,
      createCheckRun: false,
      dryRun: true,
      provider: mockJev,
    });

    const decision = CostDecisionSchema.parse(result.outcome.decision);
    expect(decision.decision).toBe('warn');
    expect(decision.reason_codes).toContain('APPROACHING_BUDGET');
    expect(decision.findings).toHaveLength(2);
    expect(decision.findings.every(line => typeof line.address === 'string')).toBe(true);
    expect(result.effects).toEqual(['set-outputs', 'write-summary']);
  });
});
