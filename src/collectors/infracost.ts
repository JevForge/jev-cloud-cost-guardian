import type { EnvironmentName } from '../schemas/enums.js';
import type { CostLine } from '../schemas/cost.js';
import { parseCost } from '../utils/money.js';
import { parseYamlOrJson } from '../utils/fs.js';
import { makeLine } from './line.js';
import type { CollectResult } from './types.js';

interface InfracostComponent {
  name?: string;
  unit?: string;
  monthlyQuantity?: string | number;
  price?: string | number;
  monthlyCost?: string | number | null;
}

interface InfracostResource {
  name?: string;
  resourceType?: string;
  monthlyCost?: string | number | null;
  costComponents?: InfracostComponent[];
}

interface InfracostBreakdown {
  resources?: InfracostResource[];
  totalMonthlyCost?: string | number | null;
}

interface InfracostProject {
  name?: string;
  breakdown?: InfracostBreakdown;
  pastBreakdown?: InfracostBreakdown;
  diff?: InfracostBreakdown;
}

interface InfracostFile {
  currency?: string;
  projects?: InfracostProject[];
  totalMonthlyCost?: string | number | null;
  pastTotalMonthlyCost?: string | number | null;
  diffTotalMonthlyCost?: string | number | null;
}

function componentsOf(resource: InfracostResource) {
  return (resource.costComponents ?? []).slice(0, 32).map(component => ({
    name: component.name || 'component',
    monthly_cost: parseCost(component.monthlyCost),
    unit: component.unit,
    quantity: parseCost(component.monthlyQuantity) ?? undefined,
    price: parseCost(component.price) ?? undefined,
  }));
}

function resourceLines(
  resources: InfracostResource[] | undefined,
  environment: EnvironmentName,
  currency: string,
  change: 'create' | 'update' | 'delete' | 'baseline',
): CostLine[] {
  const lines: CostLine[] = [];
  for (const resource of resources ?? []) {
    const address = resource.name || resource.resourceType || 'unknown-resource';
    const monthly = parseCost(resource.monthlyCost);
    lines.push(
      makeLine({
        source: 'infracost',
        service: resource.resourceType || 'infracost',
        resource_type: resource.resourceType || 'unknown',
        address,
        environment,
        change,
        monthly_cost: monthly,
        currency,
        normalization: 'monthly',
        partial: monthly == null,
        detail_code: monthly == null ? 'NO_MATCHING_PRICE' : undefined,
        components: componentsOf(resource),
      }),
    );
  }
  return lines;
}

export function parseInfracostDocument(
  document: unknown,
  environment: EnvironmentName,
  fallbackCurrency: string,
): CollectResult {
  const file = (document ?? {}) as InfracostFile;
  const currency = (file.currency || fallbackCurrency).toUpperCase();
  const projects = file.projects ?? [];
  const lines: CostLine[] = [];
  const warnings: string[] = [];

  if (projects.length) {
    for (const project of projects) {
      const diffResources = project.diff?.resources;
      const diffTotal = parseCost(project.diff?.totalMonthlyCost);
      const hasDiff = Boolean(diffResources?.length) || diffTotal != null;
      const past = parseCost(project.pastBreakdown?.totalMonthlyCost);
      if (hasDiff && past != null) {
        lines.push(
          makeLine({
            source: 'infracost',
            service: 'baseline',
            resource_type: 'baseline',
            address: `${project.name || 'project'}:baseline`,
            environment,
            change: 'baseline',
            monthly_cost: past,
            currency,
            normalization: 'monthly',
          }),
        );
      }
      if (diffResources?.length) {
        lines.push(...resourceLines(diffResources, environment, currency, 'update'));
      } else if (diffTotal != null) {
        lines.push(
          makeLine({
            source: 'infracost',
            service: 'infracost',
            resource_type: 'diff',
            address: `${project.name || 'project'}:diff`,
            environment,
            change: 'update',
            monthly_cost: diffTotal,
            currency,
            normalization: 'monthly',
          }),
        );
      } else {
        lines.push(...resourceLines(project.breakdown?.resources, environment, currency, 'create'));
      }
    }
  } else if (file.totalMonthlyCost != null || file.diffTotalMonthlyCost != null) {
    const delta = parseCost(file.diffTotalMonthlyCost ?? file.totalMonthlyCost);
    lines.push(
      makeLine({
        source: 'infracost',
        service: 'infracost',
        resource_type: 'project',
        address: 'infracost:total',
        environment,
        change: 'create',
        monthly_cost: delta,
        currency,
        normalization: 'monthly',
      }),
    );
  }

  if (!lines.length) {
    warnings.push('Infracost output contained no priced resources');
    lines.push(
      makeLine({
        source: 'infracost',
        service: 'infracost',
        resource_type: 'project',
        address: 'infracost:empty',
        environment,
        change: 'create',
        monthly_cost: null,
        currency,
        normalization: 'monthly',
        detail_code: 'NO_MATCHING_PRICE',
      }),
    );
  }

  if (lines.length > 5_000) {
    throw new Error(`Refusing to truncate ${lines.length} Infracost cost lines`);
  }
  return { lines, warnings };
}

export function parseInfracostText(
  text: string,
  environment: EnvironmentName,
  currency: string,
): CollectResult {
  return parseInfracostDocument(parseYamlOrJson(text, 'infracost'), environment, currency);
}
