import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCostExplorerResponse, parseForecastResponse } from '../../src/collectors/aws-billing.js';
import { collectAzureBilling, fetchAzureToken } from '../../src/collectors/azure-billing.js';
import {
  pickBoolean,
  pickBudgetScope,
  pickEnvironment,
  pickNumber,
  pickPolicy,
  pickProvider,
  pickString,
} from '../../src/collectors/config.js';
import { collectGcpBilling, resolveGcpAccessToken } from '../../src/collectors/gcp-billing.js';
import { parseInfracostDocument } from '../../src/collectors/infracost.js';
import { loadCostReport } from '../../src/collectors/load.js';
import { applyOutcome } from '../../src/github/outputs.js';
import { maybePostComment } from '../../src/executors/effects.js';
import { createJevProvider } from '../../src/jev/factory.js';
import { normalizeAnswer } from '../../src/jev/normalize.js';
import { assertStateFits, buildEvaluationState } from '../../src/jev/questions.js';
import { applyCostPolicy } from '../../src/decision/policy.js';
import { readBounded, parseYamlOrJson } from '../../src/utils/fs.js';
import { line, policyDefaults, report } from '../helpers.js';

const window = { start: '2026-09-01', end: '2026-10-01' };
const within = report([
  line({ address: 'baseline', monthly_cost: 100, change: 'baseline', service: 'baseline', resource_type: 'baseline' }),
  line({ address: 'cache', monthly_cost: 10, partial: true }),
]);

describe('edge paths', () => {
  it('rejects unsupported configuration values', () => {
    expect(pickString('', 'from-config')).toBe('from-config');
    expect(pickNumber('', 0.5, 0.75)).toBe(0.5);
    expect(pickNumber('', undefined, 0.75)).toBe(0.75);
    expect(pickBoolean('', undefined, true)).toBe(true);
    expect(() => pickBoolean('yes', undefined, false)).toThrow(/true or false/);
    expect(() => pickProvider('other', {})).toThrow(/jev_provider/);
    expect(() => pickPolicy('shrug', {})).toThrow(/low_confidence_policy/);
    expect(() => pickEnvironment('moon', {})).toThrow(/environment/);
    expect(() => pickBudgetScope('yearly', {})).toThrow(/budget_scope/);
    expect(parseYamlOrJson('currency: USD', 'catalog')).toMatchObject({ currency: 'USD' });
    expect(() => parseYamlOrJson('   ', 'empty')).toThrow(/empty/);
  });

  it('covers Infracost totals, AWS totals, and forecast failures', () => {
    const diffOnly = parseInfracostDocument(
      { currency: 'USD', projects: [{ name: 'app', diff: { totalMonthlyCost: '4' } }] },
      'production',
      'USD',
    );
    expect(diffOnly.lines[0]?.monthly_cost).toBe(4);
    const top = parseInfracostDocument({ currency: 'USD', diffTotalMonthlyCost: '6' }, 'staging', 'USD');
    expect(top.lines[0]?.address).toBe('infracost:total');
    const empty = parseInfracostDocument({ currency: 'USD', projects: [{ name: 'app' }] }, 'production', 'USD');
    expect(empty.lines[0]?.unpriced).toBe(true);

    const total = parseCostExplorerResponse(
      { ResultsByTime: [{ Total: { UnblendedCost: { Amount: '9', Unit: 'USD' } } }] },
      { environment: 'production', currency: 'USD', window, normalizeToMonthly: false },
    );
    expect(total.lines[0]?.service).toBe('AWS');
    expect(() =>
      parseCostExplorerResponse(
        { ResultsByTime: [] },
        { environment: 'production', currency: 'USD', window, normalizeToMonthly: false },
      ),
    ).toThrow(/no cost groups/);
    expect(() =>
      parseForecastResponse({}, { environment: 'production', currency: 'USD', window, normalizeToMonthly: false }),
    ).toThrow(/no total/);
  });

  it('fails closed on Azure and GCP connector errors', async () => {
    const credentials = {
      tenantId: '11111111-1111-1111-1111-111111111111',
      clientId: '22222222-2222-2222-2222-222222222222',
      clientSecret: 'secret',
      subscriptionId: '33333333-3333-3333-3333-333333333333',
    };
    await expect(
      fetchAzureToken({ ...credentials, tenantId: 'nope' }, fetch, 1000),
    ).rejects.toThrow(/tenant id/);
    await expect(
      collectAzureBilling({
        credentials,
        environment: 'production',
        currency: 'USD',
        window,
        normalizeToMonthly: false,
        timeoutMs: 1000,
        fetchImpl: (async () => new Response('denied', { status: 401 })) as typeof fetch,
      }),
    ).rejects.toThrow(/token request failed/);
  });

  it('rejects a foreign Azure nextLink and a failed BigQuery query', async () => {
    const credentials = {
      tenantId: '11111111-1111-1111-1111-111111111111',
      clientId: '22222222-2222-2222-2222-222222222222',
      clientSecret: 'secret',
      subscriptionId: '33333333-3333-3333-3333-333333333333',
    };
    await expect(
      collectAzureBilling({
        credentials,
        environment: 'production',
        currency: 'USD',
        window,
        normalizeToMonthly: false,
        timeoutMs: 1000,
        accessToken: 'token',
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              properties: {
                columns: [{ name: 'Cost' }, { name: 'ServiceName' }],
                rows: [[3, 'Storage']],
                nextLink: 'https://evil.example/next',
              },
            }),
            { status: 200 },
          )) as typeof fetch,
      }),
    ).rejects.toThrow(/nextLink/);

    await expect(resolveGcpAccessToken({ timeoutMs: 1000 })).rejects.toThrow(/GCP_ACCESS_TOKEN/);
    await expect(
      collectGcpBilling({
        target: {
          projectId: 'my-billing-project',
          dataset: 'billing_export',
          table: 'export_table',
          location: 'US',
        },
        accessToken: 'token',
        environment: 'production',
        currency: 'USD',
        window,
        normalizeToMonthly: false,
        timeoutMs: 1000,
        fetchImpl: (async () => new Response('quota', { status: 429 })) as typeof fetch,
      }),
    ).rejects.toThrow(/BigQuery HTTP 429/);
  });

  it('requires a cost source and unit prices before reading manifests', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'jev-cost-edge-'));
    await expect(
      loadCostReport({
        workspace,
        environment: 'production',
        currency: 'USD',
        window,
        normalizeToMonthly: false,
        budgetMonthly: 10,
        warnUtilization: 0.8,
        blockUtilization: 1,
        budgetScope: 'projected',
        fxRates: {},
        kubernetesPaths: [],
      }),
    ).rejects.toThrow(/No cost sources/);
    writeFileSync(join(workspace, 'pod.yaml'), 'kind: Pod\n');
    await expect(
      loadCostReport({
        workspace,
        environment: 'production',
        currency: 'USD',
        window,
        normalizeToMonthly: false,
        budgetMonthly: 10,
        warnUtilization: 0.8,
        blockUtilization: 1,
        budgetScope: 'projected',
        fxRates: {},
        kubernetesPaths: ['pod.yaml'],
      }),
    ).rejects.toThrow(/k8s_unit_prices_path/);
    const file = join(workspace, 'tiny.txt');
    writeFileSync(file, 'abcdef');
    expect(() => readBounded(file, 2)).toThrow(/exceeds/);
  });

  it('tightens partial approvals and writes every policy status', async () => {
    const decision = normalizeAnswer({ decision: 'approve', confidence: 0.2, provisional: false }, within);
    expect(decision.decision).toBe('approve');
    const reviewed = applyCostPolicy(decision, within, {
      ...policyDefaults,
      lowConfidencePolicy: 'request-review',
      allowPartial: false,
      failOnBlock: false,
    });
    expect(reviewed.decision.decision).toBe('manual-review');
    const messages: string[] = [];
    await applyOutcome(
      {
        setOutput: () => undefined,
        setFailed: message => messages.push(`fail:${message}`),
        warning: message => messages.push(`warn:${message}`),
        info: message => messages.push(`info:${message}`),
        summary: () => undefined,
      },
      { status: 'no-op', decision: reviewed.decision, message: 'held' },
      'summary',
    );
    expect(messages).toContain('info:held');
    const created = await maybePostComment(false, false, reviewed.decision, null);
    expect(created).toBe('skipped');
    const posted = await maybePostComment(true, false, reviewed.decision, {
      async listComments() {
        return [];
      },
      async createComment(body) {
        expect(body).toContain('manual-review');
      },
      async updateComment() {
        throw new Error('unexpected update');
      },
    });
    expect(posted).toBe('posted');
  });

  it('refuses an oversized Jev payload and a non-HTTPS custom provider', async () => {
    const state = buildEvaluationState(within);
    state.note = 'x'.repeat(200_001);
    expect(() => assertStateFits(state)).toThrow(/omit lines/);
    const missing = await createJevProvider({
      provider: 'custom-compatible',
      timeoutMs: 1000,
    }).evaluateCost(state);
    expect(missing.unavailableMessage).toMatch(/JEV_CUSTOM_API_KEY/);
    const native = await createJevProvider({
      provider: 'typesafe-native',
      apiKey: 'key',
      timeoutMs: 1000,
    }).evaluateCost(state);
    expect(native.unavailableMessage).toMatch(/jev_endpoint/);
    expect(() => normalizeAnswer({ decision: 'approve', confidence: 4, provisional: false }, within)).toThrow(
      /SCHEMA_REJECTED/,
    );
    const offline = await createJevProvider({
      provider: 'custom-compatible',
      apiKey: 'key',
      endpoint: 'https://jev.example/evaluate',
      model: 'typesafe-ai/jev',
      timeoutMs: 1000,
      fetchImpl: (async () => {
        throw new Error('socket');
      }) as typeof fetch,
    }).evaluateCost(buildEvaluationState(within));
    expect(offline.unavailableMessage).toContain('socket');
    const noModel = await createJevProvider({
      provider: 'custom-compatible',
      apiKey: 'key',
      endpoint: 'https://jev.example/evaluate',
      timeoutMs: 1000,
    }).evaluateCost(buildEvaluationState(within));
    expect(noModel.unavailableMessage).toMatch(/jev_model/);
  });
});
