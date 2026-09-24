export function parseCost(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function roundMoney(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function daysBetween(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error(`Invalid cost window ${start}..${end}`);
  }
  return Math.round((endMs - startMs) / 86_400_000);
}

export interface MonthlyFigure {
  monthly: number;
  normalization: 'calendar-month' | 'window-scaled';
}

/**
 * Billing APIs return a window total. A 28–31 day window is treated as that
 * calendar month. Any other length is scaled only when the caller opts in.
 */
export function toMonthly(
  windowCost: number,
  start: string,
  end: string,
  normalizeToMonthly: boolean,
): MonthlyFigure {
  const days = daysBetween(start, end);
  if (days >= 28 && days <= 31) {
    return { monthly: roundMoney(windowCost), normalization: 'calendar-month' };
  }
  if (!normalizeToMonthly) {
    throw new Error(
      `Billing window is ${days} days. Set normalize_to_monthly=true to scale it to a monthly equivalent, or pass a calendar-month window.`,
    );
  }
  return {
    monthly: roundMoney(windowCost * (30.4375 / days)),
    normalization: 'window-scaled',
  };
}

export function defaultWindow(now = new Date()): { start: string; end: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return { start: isoDate(start), end: isoDate(end) };
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface FxResult {
  amount: number;
  converted: boolean;
  sourceAmount: number;
  sourceCurrency: string;
}

export function convertCurrency(
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>,
): FxResult {
  if (from === to) {
    return { amount: roundMoney(amount), converted: false, sourceAmount: amount, sourceCurrency: from };
  }
  const rate = rates[from];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Missing FX rate for ${from} to ${to}. Refusing to assume a rate.`);
  }
  return {
    amount: roundMoney(amount * rate),
    converted: true,
    sourceAmount: amount,
    sourceCurrency: from,
  };
}
