import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CostDecision } from '../schemas/decision.js';
import { resolveInside } from '../utils/sanitize.js';

export function writeDecisionJson(workspace: string, relativePath: string, decision: CostDecision): string {
  const full = resolveInside(workspace, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
  return full;
}

function sarifLevel(decision: CostDecision['decision']): 'error' | 'warning' | 'note' {
  if (decision === 'block') return 'error';
  if (decision === 'warn' || decision === 'manual-review') return 'warning';
  return 'note';
}

export function buildSarif(decision: CostDecision): Record<string, unknown> {
  const results = decision.findings.map(finding => {
    const cost =
      finding.monthly_cost == null ? 'unpriced' : `${finding.monthly_cost.toFixed(2)} ${finding.currency}`;
    return {
      ruleId: finding.unpriced ? 'unpriced-resource' : finding.partial ? 'partial-estimate' : 'cost-line',
      level: finding.unpriced || finding.partial ? 'warning' : sarifLevel(decision.decision),
      message: {
        text: `${finding.change} ${finding.service}/${finding.resource_type} at ${finding.address}: ${cost}`,
      },
      properties: {
        id: finding.id,
        source: finding.source,
        change: finding.change,
        monthly_cost: finding.monthly_cost,
        currency: finding.currency,
        detail_code: finding.detail_code ?? null,
      },
    };
  });

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'jev-cloud-cost-guardian',
            informationUri: 'https://github.com/JevForge/jev-cloud-cost-guardian',
            rules: [
              {
                id: 'cost-gate',
                shortDescription: { text: 'Cloud cost budget gate' },
                fullDescription: {
                  text: `Decision ${decision.decision} with confidence ${decision.confidence}`,
                },
                defaultConfiguration: { level: sarifLevel(decision.decision) },
                properties: {
                  decision: decision.decision,
                  reason_codes: decision.reason_codes,
                  budget_monthly: decision.budget_monthly,
                  utilization: decision.utilization,
                },
              },
              { id: 'cost-line', shortDescription: { text: 'Priced cost line' } },
              { id: 'unpriced-resource', shortDescription: { text: 'Unpriced cost line' } },
              { id: 'partial-estimate', shortDescription: { text: 'Partial cost estimate' } },
            ],
          },
        },
        results: [
          {
            ruleId: 'cost-gate',
            level: sarifLevel(decision.decision),
            message: { text: decision.summary },
            properties: {
              decision: decision.decision,
              confidence: decision.confidence,
              reason_codes: decision.reason_codes,
              findings_count: decision.findings.length,
            },
          },
          ...results,
        ],
      },
    ],
  };
}

export function writeDecisionSarif(workspace: string, relativePath: string, decision: CostDecision): string {
  const full = resolveInside(workspace, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(buildSarif(decision), null, 2)}\n`, 'utf8');
  return full;
}
