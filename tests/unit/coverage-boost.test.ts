import { describe, expect, it } from 'vitest';
import {
  loadGuardianConfig,
  pickBoolean,
  pickBudgetScope,
  pickEnvironment,
  pickNumber,
  pickPolicy,
  pickProvider,
  pickString,
  splitPaths,
} from '../../src/collectors/config.js';
import { applyOutcome, writeDecisionOutputs } from '../../src/github/outputs.js';
import { normalizeAnswer } from '../../src/jev/normalize.js';
import { line, report } from '../helpers.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('config helpers and outputs', () => {
  it('covers pick helpers and path splitting', () => {
    expect(pickString('', 'from-config', 'fallback')).toBe('from-config');
    expect(pickNumber('', 3, 1)).toBe(3);
    expect(pickNumber('2.5', undefined, 1)).toBe(2.5);
    expect(pickBoolean('true', undefined, false)).toBe(true);
    expect(pickBoolean('', true, false)).toBe(true);
    expect(() => pickBoolean('maybe', undefined, false)).toThrow(/true or false/);
    expect(pickProvider('typesafe-native', {})).toBe('typesafe-native');
    expect(pickPolicy('warn', {})).toBe('warn');
    expect(pickEnvironment('staging', {})).toBe('staging');
    expect(pickBudgetScope('delta', {})).toBe('delta');
    expect(splitPaths('a.yml, b.yml\nc.yml')).toEqual(['a.yml', 'b.yml', 'c.yml']);
    expect(splitPaths('')).toEqual([]);
  });

  it('loads include/exclude and decision paths from config', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'jev-cfg-'));
    writeFileSync(
      join(workspace, '.jev-config.yml'),
      [
        'include_resources: ["aws_instance*"]',
        'exclude_resources: ["*test*"]',
        'decision_json_path: out/decision.json',
        'sarif_path: out/cost.sarif',
        'warn_delta_pct: 0.2',
        'block_delta_pct: 0.5',
      ].join('\n'),
    );
    const config = loadGuardianConfig(workspace, '.jev-config.yml');
    expect(config.include_resources).toEqual(['aws_instance*']);
    expect(config.decision_json_path).toBe('out/decision.json');
    expect(config.warn_delta_pct).toBe(0.2);
  });

  it('writes outputs and applies warn/fail outcome statuses', async () => {
    const decision = normalizeAnswer(
      { decision: 'warn', confidence: 0.9, provisional: false },
      report([line({ address: 'baseline', monthly_cost: 100, change: 'baseline' })]),
    );
    const outputs: Record<string, string> = {};
    const messages: string[] = [];
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
      decision,
    );
    expect(outputs.decision).toBe('warn');
    expect(outputs.blocked).toBe('false');
    expect(outputs.budget_monthly).toBe('1000');

    await applyOutcome(
      {
        setOutput: () => undefined,
        setFailed: message => messages.push(`fail:${message}`),
        warning: message => messages.push(`warn:${message}`),
        info: () => undefined,
        summary: () => undefined,
      },
      { status: 'warn', decision, message: 'near' },
      'md',
    );
    expect(messages).toContain('warn:near');

    await applyOutcome(
      {
        setOutput: () => undefined,
        setFailed: message => messages.push(`fail:${message}`),
        warning: () => undefined,
        info: () => undefined,
        summary: () => undefined,
      },
      { status: 'fail', decision, message: 'blocked' },
      'md',
    );
    expect(messages).toContain('fail:blocked');
  });

  it('covers zero-budget utilization and empty budget_rule outputs', () => {
    const zeroBudget = report([line({ address: 'x', monthly_cost: 10 })], {
      budget_monthly: 0,
      budget_scope: 'delta',
      budget_rule_name: 'prod',
    });
    expect(zeroBudget.utilization).toBeNull();
    const emptyScope = report([line({ address: 'x', monthly_cost: 10 })], {
      budget_monthly: 0,
      budget_scope: 'projected',
    });
    expect(emptyScope.utilization).toBeNull();
    const decision = normalizeAnswer({ decision: 'approve', confidence: 0.95, provisional: false }, zeroBudget);
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
      { ...decision, budget_rule: null, baseline_monthly: null, projected_monthly: null, budget_remaining: null, utilization: null },
    );
    expect(outputs.budget_rule).toBe('');
    expect(outputs.baseline_monthly).toBe('');
  });
});
