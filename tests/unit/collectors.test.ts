import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregateCosts } from '../../src/collectors/aggregate.js';
import { parseCostExplorerResponse, parseForecastResponse, collectAwsBilling } from '../../src/collectors/aws-billing.js';
import { collectAzureBilling, parseAzureQueryResponse } from '../../src/collectors/azure-billing.js';
import { loadGuardianConfig } from '../../src/collectors/config.js';
import { billingQuery, collectGcpBilling, exchangeGcpServiceAccount, parseBigQueryBilling } from '../../src/collectors/gcp-billing.js';
import { parseInfracostDocument } from '../../src/collectors/infracost.js';
import { parseKubernetesYaml, parseKubecostDocument, parseUnitPrices } from '../../src/collectors/kubernetes.js';
import { loadCostReport } from '../../src/collectors/load.js';
import { parseNormalizedDocument } from '../../src/collectors/normalized.js';
import { parsePricingCatalog, parseTerraformPlan } from '../../src/collectors/terraform.js';
import { line } from '../helpers.js';
import { generateKeyPairSync } from 'node:crypto';

const window = { start: '2026-09-01', end: '2026-10-01' };
const prices = parseUnitPrices(
  { cpu_per_month: 10, memory_gib_per_month: 2, daemonset_node_count: 2, cronjob_monthly_runs: 30 },
  'USD',
);

describe('collectors', () => {
  it('reads normalized estimates and a file baseline', () => {
    const result = parseNormalizedDocument({
      environment: 'staging',
      currency: 'USD',
      document: {
        currency: 'USD',
        baseline_monthly: 100,
        lines: [{ service: 'Amazon EC2', address: 'aws_instance.web', monthly_cost: '12.5', change: 'create' }],
      },
    });
    expect(result.lines.map(item => item.change).sort()).toEqual(['baseline', 'create']);
  });

  it('uses Infracost diff as the delta and past breakdown as the baseline', () => {
    const result = parseInfracostDocument(
      {
        currency: 'USD',
        projects: [
          {
            name: 'app',
            pastBreakdown: { totalMonthlyCost: '100.00', resources: [] },
            diff: {
              totalMonthlyCost: '8.47',
              resources: [
                { name: 'aws_instance.web', resourceType: 'aws_instance', monthlyCost: '8.47', costComponents: [] },
              ],
            },
          },
        ],
      },
      'production',
      'USD',
    );
    expect(result.lines.find(item => item.change === 'baseline')?.monthly_cost).toBe(100);
    expect(result.lines.find(item => item.address === 'aws_instance.web')?.monthly_cost).toBe(8.47);
  });

  it('prices Terraform creates, deletes, and incomplete updates from the catalog', () => {
    const catalog = parsePricingCatalog(
      {
        currency: 'USD',
        rules: [
          { type: 'aws_instance', monthly_cost: 7.59, when: { instance_type: 't3.micro' } },
          { type: 'aws_instance', monthly_cost: 15.18, when: { instance_type: 't3.small' } },
        ],
      },
      'USD',
    );
    const result = parseTerraformPlan(
      {
        resource_changes: [
          {
            address: 'aws_instance.web',
            mode: 'managed',
            type: 'aws_instance',
            change: { actions: ['create'], before: null, after: { instance_type: 't3.micro', password: 'hidden' } },
          },
          {
            address: 'aws_instance.old',
            mode: 'managed',
            type: 'aws_instance',
            change: { actions: ['delete'], before: { instance_type: 't3.micro' }, after: null },
          },
          {
            address: 'aws_instance.resized',
            mode: 'managed',
            type: 'aws_instance',
            change: {
              actions: ['update'],
              before: { instance_type: 't3.micro' },
              after: { instance_type: 't3.small' },
            },
          },
          {
            address: 'aws_s3_bucket.logs',
            mode: 'managed',
            type: 'aws_s3_bucket',
            change: { actions: ['create'], before: null, after: {} },
          },
          {
            address: 'data.aws_ami.ubuntu',
            mode: 'data',
            type: 'aws_ami',
            change: { actions: ['read'], before: null, after: {} },
          },
        ],
      },
      catalog,
      'production',
    );
    const byAddress = Object.fromEntries(result.lines.map(item => [item.address, item.monthly_cost]));
    expect(byAddress['aws_instance.web']).toBe(7.59);
    expect(byAddress['aws_instance.old']).toBe(-7.59);
    expect(byAddress['aws_instance.resized']).toBeCloseTo(7.59, 2);
    expect(result.lines.find(item => item.address === 'aws_s3_bucket.logs')?.unpriced).toBe(true);
    expect(result.lines.some(item => item.address.includes('ami'))).toBe(false);
  });

  it('prices Kubernetes workloads and leaves unknown schedules visible', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: payments
spec:
  replicas: 3
  template:
    spec:
      initContainers:
        - name: migrate
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
      containers:
        - name: api
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: agent
spec:
  template:
    spec:
      containers:
        - name: agent
          resources:
            requests:
              cpu: "1"
              memory: 1Gi
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: sweep
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: sweep
              resources:
                requests:
                  cpu: 200m
                  memory: 256Mi
`;
    const priced = parseKubernetesYaml(yaml, prices, 'production');
    const deployment = priced.lines.find(item => item.address === 'payments/Deployment/api');
    expect(deployment?.monthly_cost).toBe(10.5);
    expect(deployment?.partial).toBe(true);
    expect(deployment?.detail_code).toBe('INIT_CONTAINER_NOT_PRICED');
    expect(priced.lines.find(item => item.resource_type === 'DaemonSet')?.monthly_cost).toBe(24);
    expect(priced.lines.find(item => item.resource_type === 'CronJob')?.monthly_cost).toBeGreaterThan(0);

    const unknown = parseKubernetesYaml(yaml, { ...prices, daemonset_node_count: undefined, cronjob_monthly_runs: undefined }, 'production');
    expect(unknown.lines.find(item => item.resource_type === 'DaemonSet')?.unpriced).toBe(true);
    expect(unknown.lines.find(item => item.resource_type === 'CronJob')?.detail_code).toBe('CRONJOB_SCHEDULE_UNKNOWN');
  });

  it('reads Kubecost allocations', () => {
    const result = parseKubecostDocument(
      { data: [{ payments: { name: 'payments', totalCost: 42, cpuCost: 30, ramCost: 12 } }] },
      'production',
      'USD',
      false,
    );
    expect(result.lines[0]?.monthly_cost).toBe(42);
    expect(result.lines[0]?.change).toBe('baseline');
    expect(result.warnings[0]).toMatch(/no window/);
  });

  it('normalizes AWS Cost Explorer groups and forecast lines', async () => {
    const usage = parseCostExplorerResponse(
      {
        ResultsByTime: [
          {
            Groups: [
              { Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '800', Unit: 'USD' } } },
              { Keys: ['Amazon S3'], Metrics: { UnblendedCost: { Amount: '20', Unit: 'USD' } } },
            ],
          },
        ],
      },
      { environment: 'production', currency: 'USD', window, normalizeToMonthly: false },
    );
    expect(usage.lines).toHaveLength(2);
    const withForecast = await collectAwsBilling({
      environment: 'production',
      currency: 'USD',
      window,
      normalizeToMonthly: false,
      includeForecast: true,
      client: {
        async getCostAndUsage() {
          return usage && {
            ResultsByTime: [
              { Groups: [{ Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '10', Unit: 'USD' } } }] },
            ],
          };
        },
        async getCostForecast() {
          return { Total: { Amount: '12', Unit: 'USD' } };
        },
      },
    });
    expect(withForecast.lines.some(item => item.change === 'forecast')).toBe(true);
    expect(parseForecastResponse({ Total: { Amount: '3', Unit: 'USD' } }, {
      environment: 'production',
      currency: 'USD',
      window,
      normalizeToMonthly: false,
    }).lines[0]?.change).toBe('forecast');
  });

  it('queries Azure Cost Management with a bearer token', async () => {
    const parsed = parseAzureQueryResponse(
      {
        properties: {
          columns: [{ name: 'Cost' }, { name: 'ServiceName' }],
          rows: [[15.5, 'Virtual Machines']],
        },
      },
      { environment: 'production', currency: 'USD', window, normalizeToMonthly: false },
    );
    expect(parsed.lines[0]?.service).toBe('Virtual Machines');
    expect(parsed.warnings[0]).toMatch(/currency code/);

    const calls: string[] = [];
    const result = await collectAzureBilling({
      credentials: {
        tenantId: '11111111-1111-1111-1111-111111111111',
        clientId: '22222222-2222-2222-2222-222222222222',
        clientSecret: 'secret-value',
        subscriptionId: '33333333-3333-3333-3333-333333333333',
      },
      environment: 'production',
      currency: 'USD',
      window,
      normalizeToMonthly: false,
      timeoutMs: 1000,
      fetchImpl: (async (url: string | URL) => {
        calls.push(String(url));
        if (String(url).includes('oauth2')) {
          return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            properties: {
              columns: [{ name: 'Cost' }, { name: 'ServiceName' }, { name: 'Currency' }],
              rows: [[20, 'Storage', 'USD']],
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(calls.some(url => url.includes('CostManagement'))).toBe(true);
    expect(result.lines[0]?.monthly_cost).toBe(20);
    expect(JSON.stringify(calls)).not.toContain('secret-value');
  });

  it('builds a parameterized BigQuery billing query and parses rows', async () => {
    expect(() => billingQuery({ projectId: 'proj;drop', dataset: 'billing', table: 'export', location: 'US' })).toThrow(
      /project id/,
    );
    const query = billingQuery({
      projectId: 'my-billing-project',
      dataset: 'billing_export',
      table: 'gcp_billing_export_v1_account',
      location: 'US',
    });
    expect(query).toContain('UNNEST(credits)');
    expect(query).not.toContain('undefined');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = await exchangeGcpServiceAccount(
      {
        client_email: 'jev@my-billing-project.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
      (async () => new Response(JSON.stringify({ access_token: 'gcp-token' }), { status: 200 })) as typeof fetch,
      1000,
    );
    expect(token).toBe('gcp-token');
    const collected = await collectGcpBilling({
      target: {
        projectId: 'my-billing-project',
        dataset: 'billing_export',
        table: 'gcp_billing_export_v1_account',
        location: 'US',
      },
      accessToken: 'gcp-token',
      environment: 'production',
      currency: 'USD',
      window,
      normalizeToMonthly: false,
      timeoutMs: 1000,
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        expect(body.query).toContain('my-billing-project.billing_export.gcp_billing_export_v1_account');
        return new Response(
          JSON.stringify({
            jobComplete: true,
            schema: { fields: [{ name: 'service' }, { name: 'cost' }] },
            rows: [{ f: [{ v: 'Compute Engine' }, { v: '64.25' }] }],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(collected.lines[0]?.monthly_cost).toBe(64.25);
    expect(() =>
      parseBigQueryBilling({ jobComplete: false }, {
        environment: 'production',
        currency: 'USD',
        window,
        normalizeToMonthly: false,
      }),
    ).toThrow(/partial/);
  });

  it('prefers a priced Infracost line over Terraform and converts currency', () => {
    const combined = aggregateCosts({
      lines: [
        line({ address: 'aws_instance.web', monthly_cost: 7.59, source: 'terraform-plan' }),
        line({ address: 'aws_instance.web', monthly_cost: 9, source: 'infracost' }),
        line({ address: 'baseline', monthly_cost: 10, change: 'baseline', currency: 'EUR', source: 'normalized' }),
        line({
          address: 'Amazon EC2',
          monthly_cost: 100,
          change: 'baseline',
          source: 'aws-cost-explorer',
          service: 'Amazon EC2',
        }),
      ],
      warnings: [],
      currency: 'USD',
      environment: 'production',
      window,
      budget_monthly: 1000,
      warn_utilization: 0.8,
      block_utilization: 1,
      budget_scope: 'projected',
      fx_rates: { EUR: 1.1 },
    });
    const web = combined.lines.filter(item => item.address === 'aws_instance.web');
    expect(web).toHaveLength(1);
    expect(web[0]?.source).toBe('infracost');
    expect(combined.baseline_monthly).toBe(100);
    expect(combined.warnings.some(warning => warning.includes('Ignoring normalized baseline'))).toBe(true);
    expect(combined.delta_monthly).toBe(9);
  });

  it('loads normalized, Terraform, and Kubernetes files from the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'jev-cost-'));
    mkdirSync(join(workspace, 'k8s'));
    writeFileSync(
      join(workspace, 'estimates.json'),
      JSON.stringify({ lines: [{ service: 'cache', address: 'cache', monthly_cost: 5, change: 'create' }] }),
    );
    writeFileSync(
      join(workspace, 'plan.json'),
      JSON.stringify({
        resource_changes: [
          {
            address: 'aws_instance.web',
            mode: 'managed',
            type: 'aws_instance',
            change: { actions: ['create'], after: { instance_type: 't3.micro' } },
          },
        ],
      }),
    );
    writeFileSync(
      join(workspace, 'prices.yml'),
      'currency: USD\nrules:\n  - type: aws_instance\n    monthly_cost: 7.59\n    when:\n      instance_type: t3.micro\n',
    );
    writeFileSync(
      join(workspace, 'k8s', 'api.yaml'),
      'apiVersion: v1\nkind: Pod\nmetadata:\n  name: debug\nspec:\n  containers:\n    - name: debug\n      resources:\n        requests:\n          cpu: 100m\n          memory: 128Mi\n',
    );
    writeFileSync(join(workspace, 'unit-prices.yml'), 'cpu_per_month: 10\nmemory_gib_per_month: 2\n');
    writeFileSync(join(workspace, '.jev-config.yml'), 'budget_monthly: 50\ncurrency: USD\n');
    expect(loadGuardianConfig(workspace, '.jev-config.yml').budget_monthly).toBe(50);

    const loaded = await loadCostReport({
      workspace,
      environment: 'development',
      currency: 'USD',
      window,
      normalizeToMonthly: false,
      budgetMonthly: 50,
      warnUtilization: 0.8,
      blockUtilization: 1,
      budgetScope: 'delta',
      fxRates: {},
      estimatesPath: 'estimates.json',
      terraformPlanPath: 'plan.json',
      pricingCatalogPath: 'prices.yml',
      kubernetesPaths: ['k8s'],
      k8sUnitPricesPath: 'unit-prices.yml',
    });
    expect(loaded.sources).toEqual(expect.arrayContaining(['normalized', 'terraform-plan', 'kubernetes']));
    expect(loaded.delta_monthly).toBeGreaterThan(5);
    expect(loaded.lines.find(item => item.resource_type === 'Pod')?.monthly_cost).toBeGreaterThan(0);
  });
});
