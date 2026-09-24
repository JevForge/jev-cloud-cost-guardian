import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('pricing catalog generator', () => {
  it('emits YAML rules from Infracost JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-catalog-'));
    const out = join(dir, 'catalog.yml');
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts/generate-pricing-catalog.mjs'),
        join(process.cwd(), 'tests/fixtures/infracost-sample.json'),
        out,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const yaml = readFileSync(out, 'utf8');
    expect(yaml).toContain('currency: USD');
    expect(yaml).toContain('type: aws_instance');
    expect(yaml).toContain('monthly_cost: 7.59');
    expect(yaml).toContain('type: aws_s3_bucket');
  });
});
