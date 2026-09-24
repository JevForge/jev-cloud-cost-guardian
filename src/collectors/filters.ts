import type { CostLine } from '../schemas/cost.js';

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesAny(line: CostLine, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const re = globToRegExp(pattern);
    return re.test(line.address) || re.test(line.resource_type) || re.test(line.service);
  });
}

export interface ResourceFilter {
  include?: string[];
  exclude?: string[];
}

/**
 * Mark lines that fail allowlist or match denylist. Excluded lines stay visible
 * but are zeroed for budget aggregation (original cost kept in source_monthly_cost).
 */
export function applyResourceFilters(lines: CostLine[], filter: ResourceFilter): CostLine[] {
  const include = (filter.include ?? []).map(item => item.trim()).filter(Boolean);
  const exclude = (filter.exclude ?? []).map(item => item.trim()).filter(Boolean);
  if (!include.length && !exclude.length) return lines;

  return lines.map(line => {
    const denied = exclude.length > 0 && matchesAny(line, exclude);
    const allowed = include.length === 0 || matchesAny(line, include);
    if (!denied && allowed) return line;
    return {
      ...line,
      monthly_cost: null,
      unpriced: true,
      partial: true,
      detail_code: 'RESOURCE_EXCLUDED',
      source_monthly_cost: line.source_monthly_cost ?? line.monthly_cost ?? undefined,
      source_currency: line.source_currency ?? line.currency,
    };
  });
}
