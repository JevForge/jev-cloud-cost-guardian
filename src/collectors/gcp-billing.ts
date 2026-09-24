import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { EnvironmentName } from '../schemas/enums.js';
import { parseCost, toMonthly } from '../utils/money.js';
import { safeError } from '../utils/sanitize.js';
import { makeLine } from './line.js';
import type { CollectResult } from './types.js';

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;

export interface GcpBillingTarget {
  projectId: string;
  dataset: string;
  table: string;
  location: string;
}

export interface GcpServiceAccount {
  client_email: string;
  private_key: string;
}

export function assertBillingTarget(target: GcpBillingTarget): void {
  if (!PROJECT_ID.test(target.projectId)) throw new Error('Invalid GCP project id');
  if (!IDENT.test(target.dataset)) throw new Error('Invalid GCP billing dataset');
  if (!IDENT.test(target.table)) throw new Error('Invalid GCP billing table');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(target.location)) throw new Error('Invalid GCP location');
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export async function exchangeGcpServiceAccount(
  account: GcpServiceAccount,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  if (!account.client_email || !account.private_key) {
    throw new Error('GCP service account is missing client_email or private_key');
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64url(
      JSON.stringify({
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/bigquery.readonly',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ),
  ].join('.');
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
  const assertion = `${unsigned}.${base64url(signature)}`;
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`GCP token exchange failed with HTTP ${response.status}: ${safeError(await response.text())}`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('GCP token response did not include access_token');
  return body.access_token;
}

export function loadServiceAccount(filePath: string): GcpServiceAccount {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<GcpServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not a service account JSON file');
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

export async function resolveGcpAccessToken(options: {
  accessToken?: string;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<string> {
  if (options.accessToken) return options.accessToken;
  if (!options.credentialsPath) {
    throw new Error('GCP billing requires GCP_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS');
  }
  return exchangeGcpServiceAccount(
    loadServiceAccount(options.credentialsPath),
    options.fetchImpl ?? fetch,
    options.timeoutMs,
  );
}

interface BigQueryResponse {
  jobComplete?: boolean;
  schema?: { fields?: Array<{ name?: string }> };
  rows?: Array<{ f?: Array<{ v?: string | null }> }>;
  error?: { message?: string };
}

export function parseBigQueryBilling(
  response: BigQueryResponse,
  options: {
    environment: EnvironmentName;
    currency: string;
    window: { start: string; end: string };
    normalizeToMonthly: boolean;
  },
): CollectResult {
  if (response.error?.message) throw new Error(`BigQuery billing query failed: ${safeError(response.error.message)}`);
  if (response.jobComplete === false) {
    throw new Error('BigQuery billing query did not finish. Refusing to use a partial cost result.');
  }
  const fields = response.schema?.fields ?? [];
  const serviceIndex = fields.findIndex(field => field.name === 'service');
  const costIndex = fields.findIndex(field => field.name === 'cost');
  if (serviceIndex < 0 || costIndex < 0) throw new Error('BigQuery billing response is missing service or cost');

  const lines = (response.rows ?? []).map(row => {
    const cells = row.f ?? [];
    const service = String(cells[serviceIndex]?.v ?? 'GCP');
    const cost = parseCost(cells[costIndex]?.v);
    const monthly =
      cost == null
        ? null
        : toMonthly(cost, options.window.start, options.window.end, options.normalizeToMonthly);
    return makeLine({
      source: 'gcp-bigquery-billing',
      service,
      resource_type: 'gcp-service',
      address: service,
      environment: options.environment,
      change: 'baseline',
      monthly_cost: monthly?.monthly ?? null,
      currency: options.currency,
      normalization: monthly?.normalization ?? 'monthly',
      detail_code: cost == null ? 'NO_MATCHING_PRICE' : undefined,
    });
  });
  if (!lines.length) throw new Error('GCP billing export returned no service rows for the window');
  return { lines, warnings: [] };
}

export function billingQuery(target: GcpBillingTarget): string {
  assertBillingTarget(target);
  return [
    'SELECT service.description AS service,',
    'SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS cost',
    `FROM \`${target.projectId}.${target.dataset}.${target.table}\``,
    'WHERE DATE(usage_start_time) >= @start AND DATE(usage_start_time) < @end',
    'GROUP BY service',
  ].join(' ');
}

export async function collectGcpBilling(options: {
  target: GcpBillingTarget;
  accessToken: string;
  environment: EnvironmentName;
  currency: string;
  window: { start: string; end: string };
  normalizeToMonthly: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<CollectResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = billingQuery(options.target);
  const response = await fetchImpl(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${options.target.projectId}/queries`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        useLegacySql: false,
        location: options.target.location,
        parameterMode: 'NAMED',
        queryParameters: [
          { name: 'start', parameterType: { type: 'DATE' }, parameterValue: { value: options.window.start } },
          { name: 'end', parameterType: { type: 'DATE' }, parameterValue: { value: options.window.end } },
        ],
        timeoutMs: options.timeoutMs,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(`GCP BigQuery HTTP ${response.status}: ${safeError(await response.text())}`);
  }
  const parsed = parseBigQueryBilling((await response.json()) as BigQueryResponse, options);
  return {
    lines: parsed.lines,
    warnings: [
      ...parsed.warnings,
      `GCP billing export amounts are treated as ${options.currency}. Confirm the billing account currency.`,
    ],
  };
}
