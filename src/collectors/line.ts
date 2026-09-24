import {
  type CostChange,
  type CostSource,
  type DetailCode,
  type EnvironmentName,
  type Normalization,
} from '../schemas/enums.js';
import { CostLineSchema, type CostComponent, type CostLine } from '../schemas/cost.js';
import { sanitizeLabel } from '../utils/sanitize.js';
import { roundMoney } from '../utils/money.js';

export interface LineDraft {
  source: CostSource;
  service: string;
  resource_type: string;
  address: string;
  environment: EnvironmentName;
  change: CostChange;
  monthly_cost: number | null;
  currency: string;
  normalization: Normalization;
  detail_code?: DetailCode;
  partial?: boolean;
  components?: CostComponent[];
  source_monthly_cost?: number;
  source_currency?: string;
}

export function makeLine(draft: LineDraft): CostLine {
  const currency = draft.currency.toUpperCase();
  const address = sanitizeLabel(draft.address, 256);
  const monthly = draft.monthly_cost == null ? null : roundMoney(draft.monthly_cost);
  const components = (draft.components ?? []).slice(0, 32).map(component => ({
    ...component,
    name: sanitizeLabel(component.name, 180),
    monthly_cost: component.monthly_cost == null ? null : roundMoney(component.monthly_cost),
  }));
  const line: CostLine = {
    id: sanitizeLabel(`${draft.source}:${address}`, 256),
    source: draft.source,
    service: sanitizeLabel(draft.service),
    resource_type: sanitizeLabel(draft.resource_type),
    address,
    environment: draft.environment,
    change: draft.change,
    monthly_cost: monthly,
    currency,
    unpriced: monthly == null,
    partial: draft.partial ?? false,
    normalization: draft.normalization,
    components,
  };
  if (draft.detail_code) line.detail_code = draft.detail_code;
  if (draft.source_currency && draft.source_monthly_cost != null) {
    line.source_currency = draft.source_currency.toUpperCase();
    line.source_monthly_cost = roundMoney(draft.source_monthly_cost);
  }
  return CostLineSchema.parse(line);
}
