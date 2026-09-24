import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EnvironmentName } from '../schemas/enums.js';
import type { CostLine } from '../schemas/cost.js';
import { parseYamlOrJson, readBounded } from '../utils/fs.js';
import { resolveInside } from '../utils/sanitize.js';
import { aggregateCosts, type CostReport } from './aggregate.js';
import type { AwsCostClient } from './aws-billing.js';
import { collectAwsBilling } from './aws-billing.js';
import { collectAzureBilling, type AzureCredentials } from './azure-billing.js';
import { collectGcpBilling, resolveGcpAccessToken, type GcpBillingTarget } from './gcp-billing.js';
import { parseInfracostText } from './infracost.js';
import { parseKubecostText, parseUnitPrices } from './kubernetes.js';
import { parseNormalizedDocument } from './normalized.js';
import { parsePricingCatalog, parseTerraformPlanText, type PricingCatalog } from './terraform.js';
import { resolveBudget, type BudgetRule } from './budgets.js';
import type { CollectResult } from './types.js';

export interface LoadSourcesRequest {
  workspace: string;
  environment: EnvironmentName;
  currency: string;
  window: { start: string; end: string };
  normalizeToMonthly: boolean;
  budgetMonthly: number;
  budgetRules?: BudgetRule[];
  warnUtilization: number;
  blockUtilization: number;
  budgetScope: 'projected' | 'delta';
  fxRates: Record<string, number>;
  estimatesPath?: string;
  estimatesDocument?: unknown;
  baselinePath?: string;
  requireBaseline?: boolean;
  infracostPath?: string;
  terraformPlanPath?: string;
  pricingCatalogPath?: string;
  kubernetesPaths: string[];
  k8sUnitPricesPath?: string;
  kubecostPath?: string;
  aws?: { enabled: boolean; includeForecast: boolean; client?: AwsCostClient };
  azure?: {
    enabled: boolean;
    credentials?: AzureCredentials;
    fetchImpl?: typeof fetch;
    timeoutMs: number;
    accessToken?: string;
  };
  gcp?: {
    enabled: boolean;
    target?: GcpBillingTarget;
    accessToken?: string;
    credentialsPath?: string;
    fetchImpl?: typeof fetch;
    timeoutMs: number;
  };
}

function expandKubernetes(workspace: string, paths: string[]): string[] {
  const files: string[] = [];
  for (const input of paths) {
    const full = resolveInside(workspace, input);
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full)) {
        if (name.endsWith('.yml') || name.endsWith('.yaml')) files.push(resolve(full, name));
      }
      continue;
    }
    files.push(full);
  }
  return files;
}

function readOptional(workspace: string, relativePath: string | undefined, label: string): string | undefined {
  if (!relativePath) return undefined;
  return readBounded(resolveInside(workspace, relativePath));
}

export async function loadCostReport(request: LoadSourcesRequest): Promise<CostReport> {
  const results: CollectResult[] = [];
  const estimatesText = readOptional(request.workspace, request.estimatesPath, 'estimates');
  if (estimatesText || request.estimatesDocument) {
    results.push(
      parseNormalizedDocument({
        environment: request.environment,
        currency: request.currency,
        text: estimatesText,
        document: request.estimatesDocument,
      }),
    );
  }

  const baselineText = readOptional(request.workspace, request.baselinePath, 'baseline');
  if (baselineText) {
    const parsed = parseNormalizedDocument({
      environment: request.environment,
      currency: request.currency,
      text: baselineText,
    });
    const baselineOnly = parsed.lines
      .filter(line => line.change === 'baseline' && line.monthly_cost != null)
      .map(line => ({
        ...line,
        address: line.address.startsWith('baseline:explicit')
          ? line.address
          : `baseline:explicit:${line.address}`,
        source: 'normalized' as const,
      }));
    if (!baselineOnly.length) {
      throw new Error('baseline_path must include baseline_monthly or at least one baseline cost line');
    }
    results.push({
      lines: baselineOnly,
      warnings: [
        ...parsed.warnings,
        `Loaded explicit baseline from ${request.baselinePath} (${baselineOnly.length} line(s)).`,
      ],
    });
  }

  const infracost = readOptional(request.workspace, request.infracostPath, 'infracost');
  if (infracost) results.push(parseInfracostText(infracost, request.environment, request.currency));

  const plan = readOptional(request.workspace, request.terraformPlanPath, 'terraform plan');
  if (plan) {
    const catalogText = readOptional(request.workspace, request.pricingCatalogPath, 'pricing catalog');
    const catalog: PricingCatalog = catalogText
      ? parsePricingCatalog(parseYamlOrJson(catalogText, 'pricing catalog'), request.currency)
      : { currency: request.currency, rules: [] };
    results.push(parseTerraformPlanText(plan, catalog, request.environment));
  }

  if (request.kubernetesPaths.length) {
    if (!request.k8sUnitPricesPath) {
      throw new Error('k8s_unit_prices_path is required when kubernetes manifests are provided');
    }
    const prices = parseUnitPrices(
      parseYamlOrJson(readBounded(resolveInside(request.workspace, request.k8sUnitPricesPath)), 'k8s unit prices'),
      request.currency,
    );
    const documents: unknown[] = [];
    for (const file of expandKubernetes(request.workspace, request.kubernetesPaths)) {
      const text = readBounded(file);
      const { parseAllDocuments } = await import('yaml');
      documents.push(...parseAllDocuments(text).map(doc => doc.toJSON()));
    }
    const { parseKubernetesManifests } = await import('./kubernetes.js');
    results.push(parseKubernetesManifests(documents, prices, request.environment));
  }

  const kubecost = readOptional(request.workspace, request.kubecostPath, 'kubecost');
  if (kubecost) {
    results.push(parseKubecostText(kubecost, request.environment, request.currency, request.normalizeToMonthly));
  }

  if (request.aws?.enabled) {
    const client =
      request.aws.client ??
      (await import('./aws-client.js')).createAwsCostClient(request.window);
    results.push(
      await collectAwsBilling({
        environment: request.environment,
        currency: request.currency,
        window: request.window,
        normalizeToMonthly: request.normalizeToMonthly,
        includeForecast: request.aws.includeForecast,
        client,
      }),
    );
  }

  if (request.azure?.enabled) {
    if (!request.azure.credentials) {
      throw new Error('Azure billing is enabled but credentials are missing');
    }
    results.push(
      await collectAzureBilling({
        credentials: request.azure.credentials,
        environment: request.environment,
        currency: request.currency,
        window: request.window,
        normalizeToMonthly: request.normalizeToMonthly,
        fetchImpl: request.azure.fetchImpl,
        timeoutMs: request.azure.timeoutMs,
        accessToken: request.azure.accessToken,
      }),
    );
  }

  if (request.gcp?.enabled) {
    if (!request.gcp.target) throw new Error('GCP billing requires project, dataset, and table');
    const accessToken = await resolveGcpAccessToken({
      accessToken: request.gcp.accessToken,
      credentialsPath: request.gcp.credentialsPath,
      fetchImpl: request.gcp.fetchImpl,
      timeoutMs: request.gcp.timeoutMs,
    });
    results.push(
      await collectGcpBilling({
        target: request.gcp.target,
        accessToken,
        environment: request.environment,
        currency: request.currency,
        window: request.window,
        normalizeToMonthly: request.normalizeToMonthly,
        fetchImpl: request.gcp.fetchImpl,
        timeoutMs: request.gcp.timeoutMs,
      }),
    );
  }

  const lines: CostLine[] = results.flatMap(result => result.lines);
  const warnings = results.flatMap(result => result.warnings);
  if (!lines.length) {
    throw new Error('No cost sources were configured. Pass estimates, a plan, or a billing connector.');
  }
  if (lines.length > 5_000) throw new Error(`Refusing to truncate ${lines.length} cost lines`);

  const resolved = resolveBudget(
    request.environment,
    lines,
    request.budgetRules,
    request.budgetMonthly,
  );
  if (resolved.matched) {
    warnings.push(
      `Applied budget rule ${resolved.rule_name ?? 'matched-rule'} (${resolved.monthly} ${request.currency}/month).`,
    );
  }

  const report = aggregateCosts({
    lines,
    warnings,
    currency: request.currency,
    environment: request.environment,
    window: request.window,
    budget_monthly: resolved.monthly,
    budget_rule_name: resolved.rule_name,
    warn_utilization: request.warnUtilization,
    block_utilization: request.blockUtilization,
    budget_scope: request.budgetScope,
    fx_rates: request.fxRates,
  });
  if (
    request.requireBaseline &&
    request.budgetScope === 'projected' &&
    !report.baseline_known
  ) {
    throw new Error(
      'require_baseline is true and budget_scope is projected, but no baseline was found. Pass baseline_path or a billing/estimate baseline source.',
    );
  }
  return report;
}
