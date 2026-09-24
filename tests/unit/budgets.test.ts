import { describe, expect, it } from 'vitest';
import { resolveBudget } from '../../src/collectors/budgets.js';
import { line } from '../helpers.js';

describe('resolveBudget', () => {
  const lines = [
    line({ address: 'module.api.aws_instance.web', monthly_cost: 40, service: 'Amazon EC2' }),
    line({ address: 'module.db.aws_db_instance.main', monthly_cost: 80, service: 'Amazon RDS' }),
  ];

  it('falls back to the global monthly budget when no rules match', () => {
    const resolved = resolveBudget('production', lines, [{ monthly: 200, environment: 'staging' }], 1000);
    expect(resolved).toEqual({ monthly: 1000, rule_name: null, matched: false });
  });

  it('prefers the most specific matching rule', () => {
    const resolved = resolveBudget(
      'production',
      lines,
      [
        { name: 'prod-global', monthly: 5000, environment: 'production' },
        { name: 'prod-api', monthly: 300, environment: 'production', path: 'module.api.*' },
        { name: 'rds-only', monthly: 100, service: 'Amazon RDS' },
      ],
      1000,
    );
    expect(resolved.matched).toBe(true);
    expect(resolved.monthly).toBe(300);
    expect(resolved.rule_name).toBe('prod-api');
  });

  it('matches service rules case-insensitively', () => {
    const resolved = resolveBudget(
      'staging',
      lines,
      [{ name: 'ec2', monthly: 50, service: 'amazon ec2' }],
      1000,
    );
    expect(resolved).toEqual({ monthly: 50, rule_name: 'ec2', matched: true });
  });
});
