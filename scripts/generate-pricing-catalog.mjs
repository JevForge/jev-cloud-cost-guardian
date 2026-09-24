#!/usr/bin/env node
/**
 * Generate a Terraform pricing catalog YAML from an Infracost breakdown JSON.
 *
 * Usage:
 *   node scripts/generate-pricing-catalog.mjs <infracost.json> [out.yml]
 *   npm run catalog:from-infracost -- infracost.json pricing-catalog.yml
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseCost(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

function collectResources(file) {
  const resources = [];
  for (const project of file.projects ?? []) {
    for (const section of [project.breakdown, project.diff, project.pastBreakdown]) {
      for (const resource of section?.resources ?? []) {
        resources.push(resource);
      }
    }
  }
  return resources;
}

function buildRules(resources) {
  /** @type {Map<string, { type: string, monthly_cost: number, when?: Record<string, string> }>} */
  const byKey = new Map();
  for (const resource of resources) {
    const type = resource.resourceType || resource.name?.split('.')?.[0];
    const monthly = parseCost(resource.monthlyCost);
    if (!type || monthly == null) continue;
    const when = {};
    for (const component of resource.costComponents ?? []) {
      if (component.name && /instance.?type/i.test(component.name) && component.monthlyQuantity != null) {
        // Keep broad type-level rules; attribute matching is filled manually when needed.
      }
    }
    const key = `${type}|${monthly.toFixed(4)}`;
    if (!byKey.has(key)) {
      byKey.set(key, { type, monthly_cost: Number(monthly.toFixed(4)), ...(Object.keys(when).length ? { when } : {}) });
    }
  }
  return [...byKey.values()].sort((a, b) => a.type.localeCompare(b.type) || a.monthly_cost - b.monthly_cost);
}

function toYaml(catalog) {
  const lines = [`currency: ${catalog.currency}`, 'rules:'];
  for (const rule of catalog.rules) {
    lines.push(`  - type: ${rule.type}`);
    lines.push(`    monthly_cost: ${rule.monthly_cost}`);
    if (rule.when) {
      lines.push('    when:');
      for (const [key, value] of Object.entries(rule.when)) {
        lines.push(`      ${key}: ${JSON.stringify(value)}`);
      }
    }
  }
  if (!catalog.rules.length) lines.push('  []');
  return `${lines.join('\n')}\n`;
}

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? 'pricing-catalog.yml';
if (!inputPath) {
  console.error('Usage: node scripts/generate-pricing-catalog.mjs <infracost.json> [out.yml]');
  process.exit(1);
}

const file = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
const currency = String(file.currency || 'USD').toUpperCase();
const rules = buildRules(collectResources(file));
const yaml = toYaml({ currency, rules });
writeFileSync(resolve(outputPath), yaml, 'utf8');
console.log(`Wrote ${rules.length} rule(s) to ${outputPath}`);
