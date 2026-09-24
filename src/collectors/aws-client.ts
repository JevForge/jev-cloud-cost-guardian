import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer';
import { withRetries } from '../utils/retry.js';
import type { AwsCostClient } from './aws-billing.js';

export function createAwsCostClient(window: { start: string; end: string }): AwsCostClient {
  const client = new CostExplorerClient({ region: 'us-east-1' });
  return {
    async getCostAndUsage() {
      const response = await withRetries(() =>
        client.send(
          new GetCostAndUsageCommand({
            TimePeriod: { Start: window.start, End: window.end },
            Granularity: 'MONTHLY',
            Metrics: ['UnblendedCost'],
            GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
          }),
        ),
      );
      return {
        ResultsByTime: response.ResultsByTime?.map(period => ({
          Groups: period.Groups?.map(group => ({
            Keys: group.Keys,
            Metrics: {
              UnblendedCost: {
                Amount: group.Metrics?.UnblendedCost?.Amount,
                Unit: group.Metrics?.UnblendedCost?.Unit,
              },
            },
          })),
          Total: {
            UnblendedCost: {
              Amount: period.Total?.UnblendedCost?.Amount,
              Unit: period.Total?.UnblendedCost?.Unit,
            },
          },
        })),
      };
    },
    async getCostForecast() {
      const response = await withRetries(() =>
        client.send(
          new GetCostForecastCommand({
            TimePeriod: { Start: window.start, End: window.end },
            Granularity: 'MONTHLY',
            Metric: 'UNBLENDED_COST',
          }),
        ),
      );
      return {
        Total: { Amount: response.Total?.Amount, Unit: response.Total?.Unit },
        ForecastResultsByTime: response.ForecastResultsByTime?.map(item => ({
          MeanValue: item.MeanValue,
        })),
      };
    },
  };
}
