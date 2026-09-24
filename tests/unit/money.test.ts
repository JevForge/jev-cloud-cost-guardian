import { describe, expect, it } from 'vitest';
import { convertCurrency, daysBetween, defaultWindow, parseCost, toMonthly } from '../../src/utils/money.js';
import { redactLine, redactSecrets, resolveInside } from '../../src/utils/sanitize.js';
import { line } from '../helpers.js';

describe('money and redaction', () => {
  it('parses numeric strings and rejects blanks', () => {
    expect(parseCost('12.50')).toBe(12.5);
    expect(parseCost('')).toBeNull();
    expect(parseCost('nope')).toBeNull();
  });

  it('treats a calendar month as monthly and scales other windows only when asked', () => {
    expect(daysBetween('2026-09-01', '2026-10-01')).toBe(30);
    expect(toMonthly(300, '2026-09-01', '2026-10-01', false).normalization).toBe('calendar-month');
    expect(toMonthly(70, '2026-09-01', '2026-09-08', true).monthly).toBeCloseTo(70 * (30.4375 / 7), 4);
    expect(() => toMonthly(70, '2026-09-01', '2026-09-08', false)).toThrow(/normalize_to_monthly/);
  });

  it('refuses a missing FX rate', () => {
    expect(convertCurrency(10, 'USD', 'USD', {}).converted).toBe(false);
    expect(convertCurrency(10, 'EUR', 'USD', { EUR: 1.08 }).amount).toBe(10.8);
    expect(() => convertCurrency(10, 'EUR', 'USD', {})).toThrow(/Missing FX rate/);
  });

  it('redacts secrets and resource addresses', () => {
    expect(redactSecrets('token sk-abcdefghijklmnopqrstuvwxyz and Bearer abcdefghijklmnopqrstuvwxyz')).not.toContain('sk-');
    const hidden = redactLine(line({ address: 'aws_instance.web', monthly_cost: 4 }));
    expect(hidden.address.startsWith('redacted:')).toBe(true);
    expect(hidden.monthly_cost).toBe(4);
  });

  it('rejects paths that leave the workspace', () => {
    expect(() => resolveInside(process.cwd(), '../secret')).toThrow(/escapes workspace/);
  });

  it('builds a UTC month window', () => {
    expect(defaultWindow(new Date('2026-09-24T12:00:00Z'))).toEqual({
      start: '2026-09-01',
      end: '2026-10-01',
    });
  });
});
