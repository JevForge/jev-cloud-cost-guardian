import { describe, expect, it } from 'vitest';
import { applyResourceFilters } from '../../src/collectors/filters.js';
import { line } from '../helpers.js';

describe('resource filters', () => {
  const lines = [
    line({ address: 'aws_instance.web', monthly_cost: 40, resource_type: 'aws_instance', service: 'Amazon EC2' }),
    line({ address: 'aws_s3_bucket.logs', monthly_cost: 5, resource_type: 'aws_s3_bucket', service: 'Amazon S3' }),
  ];

  it('excludes denylist matches from totals but keeps findings', () => {
    const filtered = applyResourceFilters(lines, { exclude: ['aws_s3_bucket*'] });
    expect(filtered).toHaveLength(2);
    expect(filtered[0]?.monthly_cost).toBe(40);
    expect(filtered[1]?.detail_code).toBe('RESOURCE_EXCLUDED');
    expect(filtered[1]?.monthly_cost).toBeNull();
    expect(filtered[1]?.source_monthly_cost).toBe(5);
  });

  it('keeps only allowlist matches in totals', () => {
    const filtered = applyResourceFilters(lines, { include: ['*web*'] });
    expect(filtered[0]?.monthly_cost).toBe(40);
    expect(filtered[1]?.detail_code).toBe('RESOURCE_EXCLUDED');
  });
});
