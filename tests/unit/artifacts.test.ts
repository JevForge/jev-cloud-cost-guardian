import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSarif, writeDecisionJson, writeDecisionSarif } from '../../src/github/artifacts.js';
import { normalizeAnswer } from '../../src/jev/normalize.js';
import { line, report } from '../helpers.js';

const decision = normalizeAnswer(
  { decision: 'warn', confidence: 0.9, provisional: false },
  report([
    line({ address: 'baseline', monthly_cost: 800, change: 'baseline' }),
    line({ address: 'aws_instance.web', monthly_cost: 50, partial: true }),
  ]),
);

describe('decision artifacts', () => {
  it('writes decision JSON with every finding', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'jev-artifacts-'));
    const path = writeDecisionJson(workspace, 'out/cost-decision.json', decision);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof decision;
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.decision).toBe('warn');
  });

  it('builds SARIF that never drops findings', () => {
    const sarif = buildSarif(decision) as {
      runs: Array<{ results: Array<{ ruleId: string }> }>;
    };
    expect(sarif.runs[0]?.results.length).toBe(1 + decision.findings.length);
    const workspace = mkdtempSync(join(tmpdir(), 'jev-sarif-'));
    const path = writeDecisionSarif(workspace, 'out/cost.sarif', decision);
    expect(readFileSync(path, 'utf8')).toContain('cost-gate');
  });
});
