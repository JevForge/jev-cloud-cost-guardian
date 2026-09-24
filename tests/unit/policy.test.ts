import { describe, expect, it } from 'vitest';
import { applyCostPolicy } from '../../src/decision/policy.js';
import { normalizeAnswer } from '../../src/jev/normalize.js';
import { line, policyDefaults, report } from '../helpers.js';
import { effectsFor, maybePostComment, renderSummaryMarkdown } from '../../src/executors/effects.js';
import { writeDecisionOutputs } from '../../src/github/outputs.js';

const within = report([
  line({ address: 'baseline', monthly_cost: 100, change: 'baseline', service: 'baseline', resource_type: 'baseline' }),
  line({ address: 'cache', monthly_cost: 20 }),
]);
const over = report([
  line({ address: 'baseline', monthly_cost: 900, change: 'baseline', service: 'baseline', resource_type: 'baseline' }),
  line({ address: 'cluster', monthly_cost: 200 }),
]);

describe('deterministic policy', () => {
  it('keeps an in-budget approve from Jev', () => {
    const decision = normalizeAnswer({ decision: 'approve', confidence: 0.91, provisional: false }, within);
    const outcome = applyCostPolicy(decision, within, policyDefaults);
    expect(outcome.status).toBe('ok');
    expect(outcome.decision.decision).toBe('approve');
  });

  it('does not loosen a block that Jev chose under budget', () => {
    const decision = normalizeAnswer({ decision: 'block', confidence: 0.88, provisional: false }, within);
    const outcome = applyCostPolicy(decision, within, policyDefaults);
    expect(outcome.decision.decision).toBe('block');
    expect(outcome.status).toBe('fail');
  });

  it('tightens approve and warn to block when the configured ceiling is crossed', () => {
    for (const choice of ['approve', 'warn'] as const) {
      const decision = normalizeAnswer({ decision: choice, confidence: 0.93, provisional: false }, over);
      const outcome = applyCostPolicy(decision, over, policyDefaults);
      expect(outcome.decision.decision).toBe('block');
      expect(outcome.decision.reason_codes).toContain('HARD_BLOCK_THRESHOLD');
      expect(outcome.status).toBe('fail');
    }
  });

  it('never approves when Jev is unavailable or confidence is low', () => {
    const unavailable = normalizeAnswer(
      { decision: null, confidence: 0, provisional: true, unavailableMessage: 'timeout' },
      within,
    );
    expect(unavailable.decision).toBe('manual-review');
    expect(unavailable.provisional).toBe(true);
    expect(unavailable.findings).toHaveLength(2);
    expect(applyCostPolicy(unavailable, within, policyDefaults).status).toBe('fail');
    expect(applyCostPolicy(unavailable, within, { ...policyDefaults, lowConfidencePolicy: 'no-op' }).status).toBe('no-op');

    const low = normalizeAnswer({ decision: 'approve', confidence: 0.2, provisional: false }, within);
    const failed = applyCostPolicy(low, within, policyDefaults);
    expect(failed.decision.decision).not.toBe('approve');
    expect(failed.status).toBe('fail');
    expect(failed.decision.reason_codes).toContain('LOW_CONFIDENCE');
  });

  it('keeps unpriced and missing-baseline approvals in manual review', () => {
    const unpricedReport = report([line({ address: 'mystery', monthly_cost: null })]);
    const unpriced = normalizeAnswer({ decision: 'approve', confidence: 0.95, provisional: false }, unpricedReport);
    expect(applyCostPolicy(unpriced, unpricedReport, policyDefaults).decision.decision).toBe('manual-review');

    const deltaOnly = report([line({ address: 'cache', monthly_cost: 20 })]);
    const missing = normalizeAnswer({ decision: 'approve', confidence: 0.95, provisional: false }, deltaOnly);
    expect(applyCostPolicy(missing, deltaOnly, policyDefaults).decision.reason_codes).toContain('MISSING_BASELINE');
  });

  it('restores cost lines the caller tried to drop', () => {
    const decision = normalizeAnswer({ decision: 'warn', confidence: 0.9, provisional: false }, within);
    const stripped = { ...decision, findings: decision.findings.slice(0, 1) };
    const outcome = applyCostPolicy(stripped, within, { ...policyDefaults, failOnBlock: false });
    expect(outcome.decision.findings).toHaveLength(2);
    expect(outcome.decision.reason_codes).toContain('COST_VISIBILITY_ENFORCED');
  });

  it('limits effects to outputs, summary, comments, and workflow failure', async () => {
    const decision = normalizeAnswer({ decision: 'warn', confidence: 0.9, provisional: false }, within);
    const outcome = applyCostPolicy(decision, within, { ...policyDefaults, failOnBlock: false });
    expect(effectsFor(outcome, true).every(effect =>
      ['set-outputs', 'write-summary', 'pull-request-comment', 'fail-workflow'].includes(effect),
    )).toBe(true);
    const markdown = renderSummaryMarkdown(outcome.decision);
    expect(markdown).toContain('does not apply infrastructure changes');
    expect(markdown).not.toContain('terraform apply');
    const outputs: Record<string, string> = {};
    writeDecisionOutputs(
      {
        setOutput: (name, value) => {
          outputs[name] = value;
        },
        setFailed: () => undefined,
        warning: () => undefined,
        info: () => undefined,
        summary: () => undefined,
      },
      outcome.decision,
    );
    expect(JSON.parse(outputs.findings ?? '[]')).toHaveLength(2);

    const status = await maybePostComment(true, false, outcome.decision, {
      async listComments() {
        return [{ id: 7, body: '<!-- jev-cloud-cost-guardian -->\nold' }];
      },
      async createComment() {
        throw new Error('should update');
      },
      async updateComment(id) {
        expect(id).toBe(7);
      },
    });
    expect(status).toBe('updated');
    expect(await maybePostComment(true, true, outcome.decision, null)).toBe('dry-run');
  });
});
