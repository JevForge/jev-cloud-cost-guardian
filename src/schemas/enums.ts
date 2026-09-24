export const DECISIONS = ['approve', 'warn', 'block', 'manual-review'] as const;
export type Decision = (typeof DECISIONS)[number];

export const JEV_PROVIDERS = [
  'vercel-ai-gateway',
  'typesafe-native',
  'custom-compatible',
] as const;
export type JevProviderId = (typeof JEV_PROVIDERS)[number];

export const LOW_CONFIDENCE_POLICIES = ['fail', 'warn', 'request-review', 'no-op'] as const;
export type LowConfidencePolicy = (typeof LOW_CONFIDENCE_POLICIES)[number];

export const ENVIRONMENTS = [
  'production',
  'staging',
  'development',
  'sandbox',
  'other',
] as const;
export type EnvironmentName = (typeof ENVIRONMENTS)[number];

export const BUDGET_SCOPES = ['projected', 'delta'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const COST_SOURCES = [
  'normalized',
  'infracost',
  'terraform-plan',
  'kubernetes',
  'kubecost',
  'aws-cost-explorer',
  'azure-cost-management',
  'gcp-bigquery-billing',
] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const COST_CHANGES = [
  'create',
  'update',
  'delete',
  'baseline',
  'forecast',
] as const;
export type CostChange = (typeof COST_CHANGES)[number];

export const NORMALIZATIONS = [
  'monthly',
  'calendar-month',
  'window-scaled',
  'unit-price',
] as const;
export type Normalization = (typeof NORMALIZATIONS)[number];

export const DETAIL_CODES = [
  'INIT_CONTAINER_NOT_PRICED',
  'CRONJOB_SCHEDULE_UNKNOWN',
  'DAEMONSET_NODE_COUNT_UNKNOWN',
  'NO_MATCHING_PRICE',
  'UPDATE_PRICE_INCOMPLETE',
  'BASELINE_SUPERSEDED',
  'RESOURCE_EXCLUDED',
] as const;
export type DetailCode = (typeof DETAIL_CODES)[number];

export const REASON_CODES = [
  'WITHIN_BUDGET',
  'APPROACHING_BUDGET',
  'EXCEEDS_BUDGET',
  'HARD_BLOCK_THRESHOLD',
  'SAVINGS',
  'NEW_SPEND',
  'HIGH_CONCENTRATION',
  'UNPRICED_RESOURCES',
  'MISSING_BASELINE',
  'EXPLICIT_BASELINE',
  'BASELINE_FROM_BILLING',
  'UNCERTAIN_ESTIMATE',
  'PROD_ENVIRONMENT',
  'NON_PROD_ENVIRONMENT',
  'BILLING_ACTUAL',
  'PLAN_DELTA',
  'FORECAST_INFORMATIONAL',
  'LOW_CONFIDENCE',
  'JEV_UNAVAILABLE',
  'POLICY_MANUAL_REVIEW',
  'COST_VISIBILITY_ENFORCED',
  'RESOURCE_FILTERED',
  'MULTI_SOURCE',
  'CURRENCY_CONVERTED',
  'WINDOW_SCALED',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const PLAN_SOURCES: readonly CostSource[] = [
  'normalized',
  'infracost',
  'terraform-plan',
  'kubernetes',
  'kubecost',
];

export const BILLING_SOURCES: readonly CostSource[] = [
  'aws-cost-explorer',
  'azure-cost-management',
  'gcp-bigquery-billing',
];
