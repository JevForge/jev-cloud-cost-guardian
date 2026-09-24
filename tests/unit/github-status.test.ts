import { describe, expect, it } from 'vitest';
import {
  applyCostLabels,
  checkConclusion,
  desiredLabels,
  isManagedCostLabel,
  maybeCreateCheckRun,
} from '../../src/executors/github-status.js';
import { normalizeAnswer } from '../../src/jev/normalize.js';
import { applyCostPolicy } from '../../src/decision/policy.js';
import { line, policyDefaults, report } from '../helpers.js';

const within = report([
  line({ address: 'baseline', monthly_cost: 100, change: 'baseline', service: 'baseline', resource_type: 'baseline' }),
  line({ address: 'cache', monthly_cost: 10 }),
]);

describe('github status', () => {
  it('builds managed labels for decisions and review', () => {
    const warn = normalizeAnswer({ decision: 'warn', confidence: 0.9, provisional: false }, within);
    expect(desiredLabels(warn)).toEqual(['jev:cost:decision:warn']);
    const review = normalizeAnswer({ decision: 'manual-review', confidence: 0.5, provisional: false }, within);
    expect(desiredLabels(review)).toEqual(['jev:cost:decision:manual-review', 'jev:cost:review']);
    expect(isManagedCostLabel('jev:cost:decision:block')).toBe(true);
    expect(isManagedCostLabel('needs-triage')).toBe(false);
  });

  it('maps policy outcomes to check conclusions', () => {
    const ok = applyCostPolicy(
      normalizeAnswer({ decision: 'approve', confidence: 0.9, provisional: false }, within),
      within,
      policyDefaults,
    );
    expect(checkConclusion(ok)).toBe('success');
    const failed = applyCostPolicy(
      normalizeAnswer({ decision: 'block', confidence: 0.9, provisional: false }, within),
      within,
      policyDefaults,
    );
    expect(checkConclusion(failed)).toBe('failure');
  });

  it('skips and dry-runs label and check effects safely', async () => {
    const decision = normalizeAnswer({ decision: 'approve', confidence: 0.9, provisional: false }, within);
    expect(await applyCostLabels(false, false, decision, null)).toBe('skipped');
    expect(await applyCostLabels(true, true, decision, null)).toBe('dry-run');
    const outcome = applyCostPolicy(decision, within, policyDefaults);
    expect(await maybeCreateCheckRun(false, false, 'sha', outcome, null)).toBe('skipped');
    expect(await maybeCreateCheckRun(true, false, null, outcome, null)).toBe('skipped');
    expect(await maybeCreateCheckRun(true, true, 'sha', outcome, null)).toBe('dry-run');
  });
});
