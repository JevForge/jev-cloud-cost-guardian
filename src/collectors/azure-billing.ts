import type { EnvironmentName } from '../schemas/enums.js';
import { parseCost, toMonthly } from '../utils/money.js';
import { fetchWithRetries } from '../utils/retry.js';
import { safeError } from '../utils/sanitize.js';
import { makeLine } from './line.js';
import type { CollectResult } from './types.js';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface AzureQueryResponse {
  properties?: {
    columns?: Array<{ name?: string }>;
    rows?: unknown[][];
    nextLink?: string;
  };
}

export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

export interface AzureCollectOptions {
  credentials: AzureCredentials;
  environment: EnvironmentName;
  currency: string;
  window: { start: string; end: string };
  normalizeToMonthly: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  accessToken?: string;
}

export function assertAzureIds(credentials: AzureCredentials): void {
  for (const [name, value] of [
    ['tenant id', credentials.tenantId],
    ['client id', credentials.clientId],
    ['subscription id', credentials.subscriptionId],
  ] as const) {
    if (!UUID.test(value)) throw new Error(`Invalid Azure ${name}`);
  }
  if (!credentials.clientSecret) throw new Error('AZURE_CLIENT_SECRET is required for Azure Cost Management');
}

export function parseAzureQueryResponse(
  response: AzureQueryResponse,
  options: Pick<AzureCollectOptions, 'environment' | 'currency' | 'window' | 'normalizeToMonthly'>,
): CollectResult {
  const columns = response.properties?.columns ?? [];
  const names = columns.map(column => column.name ?? '');
  const costIndex = names.findIndex(name => name.toLowerCase() === 'cost');
  const serviceIndex = names.findIndex(name => name.toLowerCase() === 'servicename');
  const currencyIndex = names.findIndex(name => name.toLowerCase() === 'currency');
  if (costIndex < 0) throw new Error('Azure Cost Management response has no Cost column');

  const totals = new Map<string, number>();
  const warnings: string[] = [];
  for (const row of response.properties?.rows ?? []) {
    const cost = parseCost(row[costIndex]);
    if (cost == null) continue;
    const service = serviceIndex >= 0 ? String(row[serviceIndex] ?? 'Azure') : 'Azure';
    const rowCurrency = currencyIndex >= 0 ? String(row[currencyIndex] ?? '').toUpperCase() : '';
    const lineCurrency = rowCurrency || options.currency;
    if (!rowCurrency && warnings.length === 0) {
      warnings.push(
        `Azure Cost Management did not return a currency code. Amounts are treated as ${options.currency}.`,
      );
    }
    if (rowCurrency && rowCurrency !== options.currency && warnings.every(item => !item.startsWith('Azure currency'))) {
      warnings.push(`Azure currency ${rowCurrency} will be converted to ${options.currency} when fx_rates provides a rate.`);
    }
    const totalKey = `${lineCurrency}\u0000${service}`;
    totals.set(totalKey, (totals.get(totalKey) ?? 0) + cost);
  }

  const lines = [...totals.entries()].map(([key, amount]) => {
    const separator = key.indexOf('\u0000');
    const lineCurrency = key.slice(0, separator);
    const service = key.slice(separator + 1);
    const monthly = toMonthly(amount, options.window.start, options.window.end, options.normalizeToMonthly);
    return makeLine({
      source: 'azure-cost-management',
      service,
      resource_type: 'azure-service',
      address: service,
      environment: options.environment,
      change: 'baseline',
      monthly_cost: monthly.monthly,
      currency: lineCurrency,
      normalization: monthly.normalization,
      source_monthly_cost: amount,
      source_currency: lineCurrency,
    });
  });
  if (!lines.length) throw new Error('Azure Cost Management returned no cost rows for the window');
  return { lines, warnings };
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return safeError(text).slice(0, 300);
}

export async function fetchAzureToken(
  credentials: AzureCredentials,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  assertAzureIds(credentials);
  const response = await fetchWithRetries(
    `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        scope: 'https://management.azure.com/.default',
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
    { fetchImpl },
  );
  if (!response.ok) {
    throw new Error(`Azure token request failed with HTTP ${response.status}: ${await readError(response)}`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('Azure token response did not include access_token');
  return body.access_token;
}

export async function collectAzureBilling(options: AzureCollectOptions): Promise<CollectResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token =
    options.accessToken ?? (await fetchAzureToken(options.credentials, fetchImpl, options.timeoutMs));
  const query = {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: {
      from: `${options.window.start}T00:00:00Z`,
      to: `${options.window.end}T00:00:00Z`,
    },
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [{ type: 'Dimension', name: 'ServiceName' }],
    },
  };
  const lines = [];
  const warnings: string[] = [];
  let url: string | null =
    `https://management.azure.com/subscriptions/${options.credentials.subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
  let pages = 0;
  while (url) {
    pages += 1;
    if (pages > 10) throw new Error('Azure Cost Management pagination exceeded 10 pages');
    const response = await fetchWithRetries(
      url,
      {
        method: pages === 1 ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: pages === 1 ? JSON.stringify(query) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs),
      },
      { fetchImpl },
    );
    if (!response.ok) {
      throw new Error(`Azure Cost Management HTTP ${response.status}: ${await readError(response)}`);
    }
    const body = (await response.json()) as AzureQueryResponse;
    const parsed = parseAzureQueryResponse(body, options);
    lines.push(...parsed.lines);
    warnings.push(...parsed.warnings);
    const next = body.properties?.nextLink;
    if (!next) break;
    if (!next.startsWith('https://management.azure.com/')) {
      throw new Error('Azure Cost Management nextLink is not an Azure management URL');
    }
    url = next;
  }
  return { lines, warnings };
}
