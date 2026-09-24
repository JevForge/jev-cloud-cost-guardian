import YAML from 'yaml';
import { z } from 'zod';
import type { DetailCode, EnvironmentName } from '../schemas/enums.js';
import type { CostLine } from '../schemas/cost.js';
import { parseCost, roundMoney, toMonthly } from '../utils/money.js';
import { parseYamlOrJson } from '../utils/fs.js';
import { makeLine } from './line.js';
import type { CollectResult } from './types.js';

const PricesSchema = z
  .object({
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    cpu_per_month: z.number().finite().nonnegative(),
    memory_gib_per_month: z.number().finite().nonnegative(),
    daemonset_node_count: z.number().int().positive().optional(),
    cronjob_monthly_runs: z.number().finite().positive().optional(),
    include_init_containers: z.boolean().optional(),
    use_resource_limits: z.boolean().optional(),
    prefer_hpa_max_replicas: z.boolean().optional(),
  })
  .strict();

export interface K8sUnitPrices {
  currency: string;
  cpu_per_month: number;
  memory_gib_per_month: number;
  daemonset_node_count?: number;
  cronjob_monthly_runs?: number;
  include_init_containers: boolean;
  use_resource_limits: boolean;
  prefer_hpa_max_replicas: boolean;
}

export function parseUnitPrices(document: unknown, fallbackCurrency: string): K8sUnitPrices {
  const parsed = PricesSchema.parse(document);
  return {
    currency: (parsed.currency ?? fallbackCurrency).toUpperCase(),
    cpu_per_month: parsed.cpu_per_month,
    memory_gib_per_month: parsed.memory_gib_per_month,
    daemonset_node_count: parsed.daemonset_node_count,
    cronjob_monthly_runs: parsed.cronjob_monthly_runs,
    include_init_containers: parsed.include_init_containers ?? false,
    use_resource_limits: parsed.use_resource_limits ?? false,
    prefer_hpa_max_replicas: parsed.prefer_hpa_max_replicas ?? false,
  };
}

export function parseCpuCores(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith('m')) {
    const milli = Number(trimmed.slice(0, -1));
    return Number.isFinite(milli) ? milli / 1000 : null;
  }
  const cores = Number(trimmed);
  return Number.isFinite(cores) ? cores : null;
}

export function parseMemoryGiB(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value / 1024 ** 3;
  if (typeof value !== 'string') return null;
  const match = /^([0-9]*\.?[0-9]+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  const factors: Record<string, number> = {
    '': 1,
    K: 1_000,
    M: 1_000 ** 2,
    G: 1_000 ** 3,
    T: 1_000 ** 4,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
  };
  return (amount * (factors[unit] ?? 1)) / 1024 ** 3;
}

interface ContainerSpec {
  name?: string;
  resources?: {
    requests?: { cpu?: unknown; memory?: unknown };
    limits?: { cpu?: unknown; memory?: unknown };
  };
}

interface WorkloadDoc {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    replicas?: number;
    parallelism?: number;
    maxReplicas?: number;
    scaleTargetRef?: { kind?: string; name?: string; apiVersion?: string };
    template?: { spec?: { containers?: ContainerSpec[]; initContainers?: ContainerSpec[] } };
    jobTemplate?: {
      spec?: {
        parallelism?: number;
        template?: { spec?: { containers?: ContainerSpec[]; initContainers?: ContainerSpec[] } };
      };
    };
  };
}

function resourcesOf(
  containers: ContainerSpec[] | undefined,
  useLimits: boolean,
): {
  cpu: number;
  memory: number;
  partial: boolean;
  missingLimits: boolean;
} {
  let cpu = 0;
  let memory = 0;
  let partial = false;
  let missingLimits = false;
  for (const container of containers ?? []) {
    const cpuRequest = parseCpuCores(container.resources?.requests?.cpu);
    const memoryRequest = parseMemoryGiB(container.resources?.requests?.memory);
    const cpuLimit = parseCpuCores(container.resources?.limits?.cpu);
    const memoryLimit = parseMemoryGiB(container.resources?.limits?.memory);
    if (useLimits) {
      if (cpuLimit == null || memoryLimit == null) missingLimits = true;
      const cpuVal = Math.max(cpuRequest ?? 0, cpuLimit ?? 0);
      const memVal = Math.max(memoryRequest ?? 0, memoryLimit ?? 0);
      if ((cpuRequest == null && cpuLimit == null) || (memoryRequest == null && memoryLimit == null)) {
        partial = true;
      }
      cpu += cpuVal;
      memory += memVal;
    } else {
      if (cpuRequest == null || memoryRequest == null) partial = true;
      cpu += cpuRequest ?? 0;
      memory += memoryRequest ?? 0;
    }
  }
  return { cpu, memory, partial, missingLimits };
}

function pushWorkload(
  lines: CostLine[],
  doc: WorkloadDoc,
  prices: K8sUnitPrices,
  environment: EnvironmentName,
  hpaMaxByTarget: Map<string, number>,
): void {
  const kind = doc.kind ?? 'Workload';
  const name = doc.metadata?.name ?? 'unnamed';
  const namespace = doc.metadata?.namespace ?? 'default';
  const address = `${namespace}/${kind}/${name}`;
  const podSpec: { containers?: ContainerSpec[]; initContainers?: ContainerSpec[] } | undefined =
    kind === 'CronJob'
      ? doc.spec?.jobTemplate?.spec?.template?.spec
      : kind === 'Pod'
        ? (doc.spec as { containers?: ContainerSpec[]; initContainers?: ContainerSpec[] } | undefined)
        : doc.spec?.template?.spec;
  const containers = podSpec?.containers;
  const initContainers = podSpec?.initContainers;
  const base = resourcesOf(containers, prices.use_resource_limits);
  let replicas = doc.spec?.replicas ?? doc.spec?.parallelism ?? doc.spec?.jobTemplate?.spec?.parallelism ?? 1;
  let multiplier = 1;
  let monthly: number | null = null;
  let detail: DetailCode | undefined;
  let partial = base.partial;
  let unpricedReason: DetailCode | undefined;

  if (prices.prefer_hpa_max_replicas) {
    const hpaMax = hpaMaxByTarget.get(`${namespace}/${kind}/${name}`);
    if (hpaMax != null) {
      replicas = hpaMax;
    } else if (kind === 'Deployment' || kind === 'StatefulSet') {
      partial = true;
      detail = detail ?? 'HPA_MAX_UNKNOWN';
    }
  }

  if (kind === 'DaemonSet') {
    if (!prices.daemonset_node_count) {
      unpricedReason = 'DAEMONSET_NODE_COUNT_UNKNOWN';
    } else {
      replicas = prices.daemonset_node_count;
    }
  }
  if (kind === 'CronJob') {
    if (!prices.cronjob_monthly_runs) {
      unpricedReason = 'CRONJOB_SCHEDULE_UNKNOWN';
    } else {
      multiplier = prices.cronjob_monthly_runs;
    }
  }

  const init = resourcesOf(initContainers, prices.use_resource_limits);
  if ((initContainers?.length ?? 0) > 0 && !prices.include_init_containers) {
    partial = true;
    detail = detail ?? 'INIT_CONTAINER_NOT_PRICED';
  }
  if (prices.use_resource_limits && (base.missingLimits || init.missingLimits)) {
    partial = true;
    detail = detail ?? 'LIMITS_MISSING';
  }

  if (!unpricedReason) {
    const runCpu = base.cpu + (prices.include_init_containers ? init.cpu : 0);
    const runMem = base.memory + (prices.include_init_containers ? init.memory : 0);
    monthly = roundMoney(
      replicas * multiplier * (runCpu * prices.cpu_per_month + runMem * prices.memory_gib_per_month),
    );
    if (base.partial || (prices.include_init_containers && init.partial)) partial = true;
  } else {
    detail = unpricedReason;
    partial = true;
  }

  lines.push(
    makeLine({
      source: 'kubernetes',
      service: 'kubernetes',
      resource_type: kind,
      address,
      environment,
      change: 'create',
      monthly_cost: monthly,
      currency: prices.currency,
      normalization: 'unit-price',
      partial,
      detail_code: detail,
      components: [
        {
          name: 'cpu',
          monthly_cost: unpricedReason ? null : roundMoney(replicas * multiplier * base.cpu * prices.cpu_per_month),
          unit: 'cores',
          quantity: roundMoney(replicas * multiplier * base.cpu),
          price: prices.cpu_per_month,
        },
        {
          name: 'memory',
          monthly_cost: unpricedReason
            ? null
            : roundMoney(replicas * multiplier * base.memory * prices.memory_gib_per_month),
          unit: 'GiB',
          quantity: roundMoney(replicas * multiplier * base.memory),
          price: prices.memory_gib_per_month,
        },
      ],
    }),
  );
}

const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'ReplicaSet', 'DaemonSet', 'Job', 'CronJob', 'Pod']);

function collectHpaMax(documents: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const document of documents) {
    if (!document || typeof document !== 'object') continue;
    const doc = document as WorkloadDoc;
    if (doc.kind !== 'HorizontalPodAutoscaler') continue;
    const namespace = doc.metadata?.namespace ?? 'default';
    const kind = doc.spec?.scaleTargetRef?.kind;
    const name = doc.spec?.scaleTargetRef?.name;
    const maxReplicas = doc.spec?.maxReplicas;
    if (!kind || !name || maxReplicas == null || !Number.isFinite(maxReplicas)) continue;
    map.set(`${namespace}/${kind}/${name}`, maxReplicas);
  }
  return map;
}

export function parseKubernetesManifests(
  documents: unknown[],
  prices: K8sUnitPrices,
  environment: EnvironmentName,
): CollectResult {
  const lines: CostLine[] = [];
  const hpaMaxByTarget = collectHpaMax(documents);
  for (const document of documents) {
    if (!document || typeof document !== 'object') continue;
    const doc = document as WorkloadDoc;
    if (!doc.kind || !WORKLOADS.has(doc.kind)) continue;
    pushWorkload(lines, doc, prices, environment, hpaMaxByTarget);
  }
  if (lines.length > 5_000) throw new Error(`Refusing to truncate ${lines.length} Kubernetes cost lines`);
  return {
    lines,
    warnings: lines.length ? [] : ['Kubernetes manifests contained no priced workload kinds'],
  };
}

export function parseKubernetesYaml(
  text: string,
  prices: K8sUnitPrices,
  environment: EnvironmentName,
): CollectResult {
  const documents = YAML.parseAllDocuments(text).map(doc => doc.toJSON() as unknown);
  return parseKubernetesManifests(documents, prices, environment);
}

interface KubecostEntry {
  name?: string;
  totalCost?: number | string | null;
  cpuCost?: number | string | null;
  ramCost?: number | string | null;
  gpuCost?: number | string | null;
}

function kubecostEntries(document: Record<string, unknown>): KubecostEntry[] {
  if (Array.isArray(document.allocations)) return document.allocations as KubecostEntry[];
  const data = document.data;
  if (!Array.isArray(data)) return [];
  const entries: KubecostEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if ('totalCost' in record || 'name' in record) {
      entries.push(record as KubecostEntry);
      continue;
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') entries.push(value as KubecostEntry);
    }
  }
  return entries;
}

export function parseKubecostDocument(
  document: unknown,
  environment: EnvironmentName,
  currency: string,
  normalizeToMonthly: boolean,
): CollectResult {
  const file = (document ?? {}) as Record<string, unknown>;
  const window = file.window as { start?: string; end?: string } | undefined;
  const entries = kubecostEntries(file);
  const lines: CostLine[] = [];
  for (const entry of entries) {
    const raw = parseCost(entry.totalCost);
    let monthly = raw;
    let normalization: 'monthly' | 'calendar-month' | 'window-scaled' = 'monthly';
    if (raw != null && window?.start && window?.end) {
      const scaled = toMonthly(raw, window.start, window.end, normalizeToMonthly);
      monthly = scaled.monthly;
      normalization = scaled.normalization;
    }
    const name = entry.name || 'allocation';
    lines.push(
      makeLine({
        source: 'kubecost',
        service: 'kubernetes',
        resource_type: 'allocation',
        address: name,
        environment,
        change: 'baseline',
        monthly_cost: monthly,
        currency,
        normalization,
        components: [
          { name: 'cpu', monthly_cost: parseCost(entry.cpuCost) },
          { name: 'memory', monthly_cost: parseCost(entry.ramCost) },
          { name: 'gpu', monthly_cost: parseCost(entry.gpuCost) },
        ].filter(component => component.monthly_cost != null),
      }),
    );
  }
  if (!lines.length) {
    throw new Error('Kubecost allocation contained no cost entries');
  }
  return {
    lines,
    warnings: window?.start ? [] : ['Kubecost export had no window; totals were used as monthly figures'],
  };
}

export function parseKubecostText(
  text: string,
  environment: EnvironmentName,
  currency: string,
  normalizeToMonthly: boolean,
): CollectResult {
  return parseKubecostDocument(parseYamlOrJson(text, 'kubecost'), environment, currency, normalizeToMonthly);
}
