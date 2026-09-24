import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCostReport } from '../../src/collectors/load.js';
import { line, report } from '../helpers.js';
import { factualReasonCodes } from '../../src/jev/normalize.js';

describe('explicit baseline', () => {
  it('loads baseline_path and marks origin as explicit', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'jev-baseline-'));
    writeFileSync(join(workspace, 'baseline.yml'), 'baseline_monthly: 900\ncurrency: USD\n');
    writeFileSync(
      join(workspace, 'estimates.yml'),
      JSON.stringify({
        currency: 'USD',
        lines: [{ service: 'Amazon EC2', resource_type: 'aws_instance', address: 'aws_instance.web', monthly_cost: 50 }],
      }),
    );
    const result = await loadCostReport({
      workspace,
      environment: 'production',
      currency: 'USD',
      window: { start: '2026-09-01', end: '2026-10-01' },
      normalizeToMonthly: false,
      budgetMonthly: 1000,
      warnUtilization: 0.8,
      blockUtilization: 1,
      budgetScope: 'projected',
      fxRates: {},
      estimatesPath: 'estimates.yml',
      baselinePath: 'baseline.yml',
      kubernetesPaths: [],
    });
    expect(result.baseline_origin).toBe('explicit');
    expect(result.baseline_monthly).toBe(900);
    expect(result.projected_monthly).toBe(950);
    expect(factualReasonCodes(result)).toContain('EXPLICIT_BASELINE');
  });

  it('fails when require_baseline is set and baseline is missing', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'jev-baseline-req-'));
    writeFileSync(
      join(workspace, 'estimates.yml'),
      JSON.stringify({
        currency: 'USD',
        lines: [{ service: 'Amazon EC2', resource_type: 'aws_instance', address: 'aws_instance.web', monthly_cost: 50 }],
      }),
    );
    await expect(
      loadCostReport({
        workspace,
        environment: 'production',
        currency: 'USD',
        window: { start: '2026-09-01', end: '2026-10-01' },
        normalizeToMonthly: false,
        budgetMonthly: 1000,
        warnUtilization: 0.8,
        blockUtilization: 1,
        budgetScope: 'projected',
        fxRates: {},
        estimatesPath: 'estimates.yml',
        requireBaseline: true,
        kubernetesPaths: [],
      }),
    ).rejects.toThrow(/require_baseline/);
  });

  it('emits BASELINE_FROM_BILLING for billing baselines', () => {
    const codes = factualReasonCodes(
      report([line({ address: 'aws', monthly_cost: 100, change: 'baseline', source: 'aws-cost-explorer' })]),
    );
    expect(codes).toContain('BASELINE_FROM_BILLING');
  });
});
