import type { JevProviderId, LowConfidencePolicy } from './schemas/enums.js';
import type { CostReport } from './collectors/aggregate.js';
import { applyCostPolicy, type PolicyOutcome } from './decision/policy.js';
import { effectsFor, maybePostComment, renderSummaryMarkdown, type CommentClient } from './executors/effects.js';
import {
  applyCostLabels,
  maybeCreateCheckRun,
  type CheckRunClient,
  type LabelClient,
} from './executors/github-status.js';
import { createJevProvider } from './jev/factory.js';
import { assertStateFits, buildEvaluationState } from './jev/questions.js';
import { normalizeAnswer } from './jev/normalize.js';
import type { JevProvider } from './jev/types.js';
import { redactLine } from './utils/sanitize.js';

export interface RunGuardianParams {
  report: CostReport;
  minConfidence: number;
  lowConfidencePolicy: LowConfidencePolicy;
  enforceBlockThreshold: boolean;
  allowUnpriced: boolean;
  allowPartial: boolean;
  allowMissingBaseline: boolean;
  failOnBlock: boolean;
  failOnManualReview: boolean;
  failOnWarn?: boolean;
  warnDeltaPct?: number | null;
  blockDeltaPct?: number | null;
  jevProvider: JevProviderId;
  jevEndpoint?: string;
  jevModel?: string;
  timeoutMs: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  provider?: JevProvider;
  redactResourceNames: boolean;
  commentOnGithub: boolean;
  applyLabels: boolean;
  createCheckRun: boolean;
  dryRun: boolean;
  headSha?: string | null;
  commentClient?: CommentClient | null;
  labelClient?: LabelClient | null;
  checkRunClient?: CheckRunClient | null;
}

export interface RunGuardianResult {
  outcome: PolicyOutcome;
  markdown: string;
  commentStatus: 'posted' | 'updated' | 'dry-run' | 'skipped';
  labelStatus: 'applied' | 'dry-run' | 'skipped';
  checkRunStatus: 'created' | 'dry-run' | 'skipped';
  effects: string[];
}

export async function runCostGuardian(params: RunGuardianParams): Promise<RunGuardianResult> {
  const report = params.redactResourceNames
    ? { ...params.report, lines: params.report.lines.map(redactLine) }
    : params.report;
  const state = buildEvaluationState(report);
  assertStateFits(state);
  const provider =
    params.provider ??
    createJevProvider({
      provider: params.jevProvider,
      apiKey: params.apiKey,
      endpoint: params.jevEndpoint,
      model: params.jevModel,
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
    });
  const answer = await provider.evaluateCost(state);
  const decision = normalizeAnswer(answer, report);
  const outcome = applyCostPolicy(decision, report, {
    minConfidence: params.minConfidence,
    lowConfidencePolicy: params.lowConfidencePolicy,
    enforceBlockThreshold: params.enforceBlockThreshold,
    allowUnpriced: params.allowUnpriced,
    allowPartial: params.allowPartial,
    allowMissingBaseline: params.allowMissingBaseline,
    failOnBlock: params.failOnBlock,
    failOnManualReview: params.failOnManualReview,
    failOnWarn: params.failOnWarn,
    warnDeltaPct: params.warnDeltaPct,
    blockDeltaPct: params.blockDeltaPct,
  });
  const effects = effectsFor(outcome, {
    comment: params.commentOnGithub && !params.dryRun,
    checkRun: params.createCheckRun && !params.dryRun && Boolean(params.headSha),
    labels: params.applyLabels && !params.dryRun,
  });
  const markdown = renderSummaryMarkdown(outcome.decision);
  const commentStatus = await maybePostComment(
    params.commentOnGithub,
    params.dryRun,
    outcome.decision,
    params.commentClient ?? null,
  );
  const labelStatus = await applyCostLabels(
    params.applyLabels,
    params.dryRun,
    outcome.decision,
    params.labelClient ?? null,
  );
  const checkRunStatus = await maybeCreateCheckRun(
    params.createCheckRun,
    params.dryRun,
    params.headSha ?? null,
    outcome,
    params.checkRunClient ?? null,
  );
  return { outcome, markdown, commentStatus, labelStatus, checkRunStatus, effects };
}
