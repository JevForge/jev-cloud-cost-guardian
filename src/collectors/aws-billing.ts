import type { EnvironmentName } from '../schemas/enums.js';
import { roundMoney, toMonthly } from '../utils/money.js';
import { makeLine } from './line.js';
import type { CollectResult } from './types.js';

export interface AwsCostGroup {
  Keys?: string[];
  Metrics?: { UnblendedCost?: { Amount?: string; Unit?: string } };
}

export interface AwsCostExplorerResponse {
  ResultsByTime?: Array<{
    Groups?: AwsCostGroup[];
    Total?: { UnblendedCost?: { Amount?: string; Unit?: string } };
  }>;
}

export interface AwsForecastResponse {
  Total?: { Amount?: string; Unit?: string };
  ForecastResultsByTime?: Array<{ MeanValue?: string }>;
}

export interface AwsCostClient {
  getCostAndUsage(): Promise<AwsCostExplorerResponse>;
  getCostForecast(): Promise<AwsForecastResponse>;
}

export interface AwsCollectOptions {
  environment: EnvironmentName;
  currency: string;
  window: { start: string; end: string };
  normalizeToMonthly: boolean;
  includeForecast: boolean;
  client: AwsCostClient;
}

function amountOf(group: AwsCostGroup | undefined): { amount: number; unit: string } | null {
  const metric = group?.Metrics?.UnblendedCost;
  if (!metric?.Amount) return null;
  const amount = Number(metric.Amount);
  if (!Number.isFinite(amount)) return null;
  return { amount, unit: (metric.Unit || 'USD').toUpperCase() };
}

export function parseCostExplorerResponse(
  response: AwsCostExplorerResponse,
  options: Omit<AwsCollectOptions, 'client' | 'includeForecast'>,
): CollectResult {
  const totals = new Map<string, { amount: number; unit: string }>();
  for (const period of response.ResultsByTime ?? []) {
    const groups = period.Groups?.length
      ? period.Groups
      : period.Total
        ? [{ Metrics: { UnblendedCost: period.Total.UnblendedCost } } satisfies AwsCostGroup]
        : [];
    for (const group of groups) {
      const parsed = amountOf(group);
      if (!parsed) continue;
      const service = group.Keys?.[0] || 'AWS';
      const current = totals.get(service) ?? { amount: 0, unit: parsed.unit };
      current.amount += parsed.amount;
      totals.set(service, current);
    }
  }

  const lines = [...totals.entries()].map(([service, total]) => {
    const monthly = toMonthly(total.amount, options.window.start, options.window.end, options.normalizeToMonthly);
    return makeLine({
      source: 'aws-cost-explorer',
      service,
      resource_type: 'aws-service',
      address: service,
      environment: options.environment,
      change: 'baseline',
      monthly_cost: monthly.monthly,
      currency: total.unit,
      normalization: monthly.normalization,
      source_monthly_cost: roundMoney(total.amount),
      source_currency: total.unit,
    });
  });

  if (!lines.length) {
    throw new Error('AWS Cost Explorer returned no cost groups for the window');
  }
  return { lines, warnings: [] };
}

export function parseForecastResponse(
  response: AwsForecastResponse,
  options: Omit<AwsCollectOptions, 'client' | 'includeForecast'>,
): CollectResult {
  const raw = response.Total?.Amount ?? response.ForecastResultsByTime?.[0]?.MeanValue;
  const amount = raw == null ? null : Number(raw);
  if (amount == null || !Number.isFinite(amount)) {
    throw new Error('AWS Cost Explorer forecast returned no total');
  }
  const unit = (response.Total?.Unit || options.currency).toUpperCase();
  const monthly = toMonthly(amount, options.window.start, options.window.end, options.normalizeToMonthly);
  return {
    lines: [
      makeLine({
        source: 'aws-cost-explorer',
        service: 'forecast',
        resource_type: 'forecast',
        address: 'aws:forecast',
        environment: options.environment,
        change: 'forecast',
        monthly_cost: monthly.monthly,
        currency: unit,
        normalization: monthly.normalization,
        source_monthly_cost: amount,
        source_currency: unit,
      }),
    ],
    warnings: [],
  };
}

export async function collectAwsBilling(options: AwsCollectOptions): Promise<CollectResult> {
  const usage = parseCostExplorerResponse(await options.client.getCostAndUsage(), options);
  if (!options.includeForecast) return usage;
  const forecast = parseForecastResponse(await options.client.getCostForecast(), options);
  return { lines: [...usage.lines, ...forecast.lines], warnings: [] };
}
