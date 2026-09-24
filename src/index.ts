import * as core from '@actions/core';
import * as github from '@actions/github';
import { z } from 'zod';
import {
  loadGuardianConfig,
  pickBoolean,
  pickBudgetScope,
  pickEnvironment,
  pickNumber,
  pickPolicy,
  pickProvider,
  pickString,
  splitPaths,
} from './collectors/config.js';
import { loadCostReport } from './collectors/load.js';
import { applyOutcome } from './github/outputs.js';
import { writeDecisionJson, writeDecisionSarif } from './github/artifacts.js';
import { runCostGuardian } from './run.js';
import { defaultWindow } from './utils/money.js';
import { safeError } from './utils/sanitize.js';
import type { CommentClient } from './executors/effects.js';
import type { CheckRunClient, LabelClient } from './executors/github-status.js';

const LOG = '[JEV Cloud Cost Guardian]';

function env(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() ? value : undefined;
}

function resolveApiKey(provider: string): string | undefined {
  if (provider === 'vercel-ai-gateway') return env('AI_GATEWAY_API_KEY');
  if (provider === 'typesafe-native') return env('TYPESAFE_API_KEY');
  return env('JEV_CUSTOM_API_KEY') || env('CUSTOM_JEV_API_KEY');
}

async function main(): Promise<void> {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const config = loadGuardianConfig(workspace);
  const jevProvider = pickProvider(core.getInput('jev_provider'), config);
  const currency = (pickString(core.getInput('currency'), config.currency, 'USD') ?? 'USD').toUpperCase();
  const environment = pickEnvironment(core.getInput('environment'), config);
  const budgetText = pickString(core.getInput('budget_monthly'), config.budget_monthly?.toString());
  if (!budgetText) {
    throw new Error(`${LOG} budget_monthly is required via input or .jev/config.yml`);
  }
  const budgetMonthly = Number(budgetText);
  if (!Number.isFinite(budgetMonthly) || budgetMonthly < 0) {
    throw new Error(`${LOG} budget_monthly must be a non-negative number`);
  }
  const fallbackWindow = defaultWindow();
  const window = {
    start: pickString(core.getInput('window_start'), config.window_start, fallbackWindow.start) ?? fallbackWindow.start,
    end: pickString(core.getInput('window_end'), config.window_end, fallbackWindow.end) ?? fallbackWindow.end,
  };
  const fxRaw = core.getInput('fx_rates').trim();
  const fxRates = fxRaw
    ? z.record(z.number().positive()).parse(JSON.parse(fxRaw) as unknown)
    : (config.fx_rates ?? {});
  const estimatesJson = core.getInput('estimates_json').trim();
  const estimatesPath = pickString(core.getInput('estimates_path'), config.estimates_path);
  if (estimatesJson && estimatesPath) {
    throw new Error(`${LOG} Pass estimates_json or estimates_path, not both`);
  }
  const kubernetesPaths = splitPaths(core.getInput('kubernetes_paths'));
  const awsEnabled = pickBoolean(core.getInput('aws_enabled'), undefined, false);
  const azureEnabled = pickBoolean(core.getInput('azure_enabled'), undefined, false);
  const gcpEnabled = pickBoolean(core.getInput('gcp_enabled'), undefined, false);

  core.info(`${LOG} Jev provider: ${jevProvider}`);
  core.info(
    `${LOG} Data sent to Jev: cost lines, budget, utilization, environment, and window. Credentials, secrets, and raw Terraform attributes are not sent.`,
  );

  const report = await loadCostReport({
    workspace,
    environment,
    currency,
    window,
    normalizeToMonthly: pickBoolean(core.getInput('normalize_to_monthly'), config.normalize_to_monthly, false),
    budgetMonthly,
    budgetRules: config.budgets,
    warnUtilization: pickNumber(core.getInput('warn_utilization'), config.warn_utilization, 0.8),
    blockUtilization: pickNumber(core.getInput('block_utilization'), config.block_utilization, 1),
    budgetScope: pickBudgetScope(core.getInput('budget_scope'), config),
    fxRates,
    estimatesPath,
    estimatesDocument: estimatesJson ? (JSON.parse(estimatesJson) as unknown) : undefined,
    baselinePath: pickString(core.getInput('baseline_path'), config.baseline_path),
    requireBaseline: pickBoolean(core.getInput('require_baseline'), config.require_baseline, false),
    includeResources: (() => {
      const fromInput = splitPaths(core.getInput('include_resources'));
      return fromInput.length ? fromInput : (config.include_resources ?? []);
    })(),
    excludeResources: (() => {
      const fromInput = splitPaths(core.getInput('exclude_resources'));
      return fromInput.length ? fromInput : (config.exclude_resources ?? []);
    })(),
    infracostPath: pickString(core.getInput('infracost_path'), config.infracost_path),
    terraformPlanPath: pickString(core.getInput('terraform_plan_path'), config.terraform_plan_path),
    pricingCatalogPath: pickString(core.getInput('pricing_catalog_path'), config.pricing_catalog_path),
    kubernetesPaths: kubernetesPaths.length ? kubernetesPaths : (config.kubernetes_paths ?? []),
    k8sUnitPricesPath: pickString(core.getInput('k8s_unit_prices_path'), config.k8s_unit_prices_path),
    kubecostPath: pickString(core.getInput('kubecost_path'), config.kubecost_path),
    aws: {
      enabled: awsEnabled,
      includeForecast: pickBoolean(core.getInput('include_aws_forecast'), config.include_aws_forecast, false),
    },
    azure: {
      enabled: azureEnabled,
      timeoutMs: pickNumber(core.getInput('connector_timeout_ms'), undefined, 20_000),
      credentials: azureEnabled
        ? {
            tenantId: env('AZURE_TENANT_ID') ?? '',
            clientId: env('AZURE_CLIENT_ID') ?? '',
            clientSecret: env('AZURE_CLIENT_SECRET') ?? '',
            subscriptionId: pickString(core.getInput('azure_subscription_id'), env('AZURE_SUBSCRIPTION_ID')) ?? '',
          }
        : undefined,
    },
    gcp: {
      enabled: gcpEnabled,
      timeoutMs: pickNumber(core.getInput('connector_timeout_ms'), undefined, 20_000),
      accessToken: env('GCP_ACCESS_TOKEN'),
      credentialsPath: env('GOOGLE_APPLICATION_CREDENTIALS'),
      target: gcpEnabled
        ? {
            projectId: pickString(core.getInput('gcp_project_id'), env('GCP_PROJECT_ID')) ?? '',
            dataset: pickString(core.getInput('gcp_billing_dataset'), env('GCP_BILLING_DATASET')) ?? '',
            table: pickString(core.getInput('gcp_billing_table'), env('GCP_BILLING_TABLE')) ?? '',
            location: pickString(core.getInput('gcp_location'), env('GCP_LOCATION'), 'US') ?? 'US',
          }
        : undefined,
    },
  });

  const commentOnGithub = pickBoolean(core.getInput('comment_on_github'), config.comment_on_github, false);
  const applyLabels = pickBoolean(core.getInput('apply_labels'), config.apply_labels, false);
  const createCheckRun = pickBoolean(core.getInput('create_check_run'), config.create_check_run, true);
  const dryRun = pickBoolean(core.getInput('dry_run'), undefined, false);
  const token = core.getInput('github_token') || process.env.GITHUB_TOKEN;
  const issueNumber = github.context.payload.pull_request?.number ?? github.context.issue?.number;
  const octokit = token ? github.getOctokit(token) : null;
  const commentClient: CommentClient | null =
    commentOnGithub && !dryRun && octokit && issueNumber
      ? {
          async listComments() {
            const comments = await octokit.rest.issues.listComments({
              owner: github.context.repo.owner,
              repo: github.context.repo.repo,
              issue_number: issueNumber,
              per_page: 100,
            });
            return comments.data.map(comment => ({ id: comment.id, body: comment.body ?? '' }));
          },
          async createComment(body: string) {
            await octokit.rest.issues.createComment({
              owner: github.context.repo.owner,
              repo: github.context.repo.repo,
              issue_number: issueNumber,
              body,
            });
          },
          async updateComment(id: number, body: string) {
            await octokit.rest.issues.updateComment({
              owner: github.context.repo.owner,
              repo: github.context.repo.repo,
              comment_id: id,
              body,
            });
          },
        }
      : null;

  const labelClient: LabelClient | null =
    applyLabels && !dryRun && octokit && issueNumber
      ? {
          async listLabels() {
            const issue = await octokit.rest.issues.get({
              owner: github.context.repo.owner,
              repo: github.context.repo.repo,
              issue_number: issueNumber,
            });
            return (issue.data.labels ?? [])
              .map(label => (typeof label === 'string' ? label : label.name))
              .filter((name): name is string => typeof name === 'string');
          },
          async ensureLabel(name: string) {
            try {
              await octokit.rest.issues.createLabel({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                name,
                color: '1D76DB',
                description: 'Managed by JEV Cloud Cost Guardian',
              });
            } catch (error) {
              const status =
                error && typeof error === 'object' && 'status' in error
                  ? Number((error as { status?: number }).status)
                  : undefined;
              if (status !== 422) throw error;
            }
          },
          async setLabels(next: string[]) {
            await octokit.rest.issues.setLabels({
              owner: github.context.repo.owner,
              repo: github.context.repo.repo,
              issue_number: issueNumber,
              labels: next,
            });
          },
        }
      : null;

  const headSha =
    github.context.payload.pull_request?.head?.sha ?? github.context.sha ?? null;
  const checkRunClient: CheckRunClient | null = octokit
    ? {
        async createCheckRun(input) {
          await octokit.rest.checks.create({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            name: input.name,
            head_sha: input.headSha,
            status: 'completed',
            conclusion: input.conclusion,
            output: {
              title: input.title,
              summary: input.summary,
            },
          });
        },
      }
    : null;

  const result = await runCostGuardian({
    report,
    minConfidence: pickNumber(core.getInput('min_confidence'), config.min_confidence, 0.75),
    lowConfidencePolicy: pickPolicy(core.getInput('low_confidence_policy'), config),
    enforceBlockThreshold: pickBoolean(core.getInput('enforce_block_threshold'), config.enforce_block_threshold, true),
    allowUnpriced: pickBoolean(core.getInput('allow_unpriced'), config.allow_unpriced, false),
    allowPartial: pickBoolean(core.getInput('allow_partial'), config.allow_partial, false),
    allowMissingBaseline: pickBoolean(
      core.getInput('allow_missing_baseline'),
      config.allow_missing_baseline,
      false,
    ),
    failOnBlock: pickBoolean(core.getInput('fail_on_block'), config.fail_on_block, true),
    failOnManualReview: pickBoolean(core.getInput('fail_on_manual_review'), config.fail_on_manual_review, false),
    failOnWarn: pickBoolean(core.getInput('fail_on_warn'), config.fail_on_warn, false),
    warnDeltaPct: (() => {
      const raw = pickString(core.getInput('warn_delta_pct'), config.warn_delta_pct?.toString());
      return raw == null || raw === '' ? null : Number(raw);
    })(),
    blockDeltaPct: (() => {
      const raw = pickString(core.getInput('block_delta_pct'), config.block_delta_pct?.toString());
      return raw == null || raw === '' ? null : Number(raw);
    })(),
    jevProvider,
    jevEndpoint: pickString(core.getInput('jev_endpoint'), config.jev_endpoint),
    jevModel: pickString(core.getInput('jev_model'), config.jev_model),
    timeoutMs: pickNumber(core.getInput('timeout_ms'), undefined, 45_000),
    apiKey: resolveApiKey(jevProvider),
    redactResourceNames: pickBoolean(core.getInput('redact_resource_names'), config.redact_resource_names, true),
    commentOnGithub,
    applyLabels,
    createCheckRun,
    dryRun,
    headSha,
    commentClient,
    labelClient,
    checkRunClient,
  });

  await applyOutcome(
    {
      setOutput: (name, value) => core.setOutput(name, value),
      setFailed: message => core.setFailed(message),
      warning: message => core.warning(message),
      info: message => core.info(message),
      summary: async markdown => {
        await core.summary.addRaw(markdown).write();
      },
    },
    result.outcome,
    result.markdown,
  );

  const decisionJsonPath = pickString(core.getInput('decision_json_path'), config.decision_json_path);
  if (decisionJsonPath) {
    const written = writeDecisionJson(workspace, decisionJsonPath, result.outcome.decision);
    core.info(`${LOG} Wrote decision JSON to ${written}`);
    core.setOutput('decision_json_path', decisionJsonPath);
  } else {
    core.setOutput('decision_json_path', '');
  }
  const sarifPath = pickString(core.getInput('sarif_path'), config.sarif_path);
  if (sarifPath) {
    const written = writeDecisionSarif(workspace, sarifPath, result.outcome.decision);
    core.info(`${LOG} Wrote SARIF to ${written}`);
    core.setOutput('sarif_path', sarifPath);
  } else {
    core.setOutput('sarif_path', '');
  }

  core.info(`${LOG} Comment: ${result.commentStatus}`);
  core.info(`${LOG} Labels: ${result.labelStatus}`);
  core.info(`${LOG} Check run: ${result.checkRunStatus}`);
  core.info(`${LOG} Effects: ${result.effects.join(', ')}`);
}

main().catch(error => {
  const message = safeError(error);
  core.setFailed(message.startsWith(LOG) ? message : `${LOG} ${message}`);
});
