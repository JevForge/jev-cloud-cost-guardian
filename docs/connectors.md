# Connectors

Every connector emits the same cost-line schema. Amounts stay visible when a price is missing (`unpriced: true`, `monthly_cost: null`).

## Normalized estimates

JSON or YAML:

```yaml
currency: USD
environment: production
baseline_monthly: 800
lines:
  - service: Amazon EC2
    resource_type: aws_instance
    address: aws_instance.web
    change: create
    monthly_cost: 12.5
```

`baseline_monthly` becomes a baseline line. It is ignored, with a warning, when a cloud billing connector also returns a baseline.

## Infracost

Pass `infracost breakdown --format json`. A project `diff` is the monthly delta and `pastBreakdown.totalMonthlyCost` is the baseline. A breakdown without a diff is treated as proposed monthly cost.

## Terraform

`terraform show -json` has no prices. Pair it with `pricing_catalog_path`:

```yaml
currency: USD
rules:
  - type: aws_instance
    monthly_cost: 7.59
    when:
      instance_type: t3.micro
```

Generate a starter catalog from an Infracost JSON export:

```bash
npm run catalog:from-infracost -- infracost.json pricing-catalog.yml
```

Creates use the after-price, deletes use the negative before-price, and updates use after minus before. A missing side is unpriced rather than guessed. Sensitive attribute names are not sent to Jev. When the same address is priced by Infracost, the Infracost line wins.

## Kubernetes and Kubecost

Manifests need `k8s_unit_prices_path` with `cpu_per_month` and `memory_gib_per_month`. DaemonSets need `daemonset_node_count`. CronJobs need `cronjob_monthly_runs`. Init containers are listed as partial and are not priced unless `include_init_containers` is true.

Optional flags in the unit-prices file:

* `use_resource_limits: true` — use `max(requests, limits)` per container; missing limits mark the line `partial` with `LIMITS_MISSING`.
* `prefer_hpa_max_replicas: true` — when an HPA targets a Deployment/StatefulSet, use `maxReplicas` instead of `spec.replicas`; missing HPA marks `HPA_MAX_UNKNOWN`.

Kubecost allocation JSON is a baseline. Its `totalCost` is monthly unless the file includes a `window`, in which case the shared month rules apply. Summing Kubecost with a cloud bill can double-count a cluster; the report warns and still shows both.

## AWS Cost Explorer

Enable `aws_enabled`. The action calls `GetCostAndUsage` in `us-east-1`, grouped by service, using the default AWS credential chain. `include_aws_forecast` adds a `forecast` line that is not added to the baseline or the delta.

## Azure Cost Management

Enable `azure_enabled` and set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `azure_subscription_id` or `AZURE_SUBSCRIPTION_ID`. The action requests a client-credentials token and runs an ActualCost query grouped by `ServiceName`.

## GCP BigQuery billing export

Enable `gcp_enabled` and set the project, dataset, and table. Authenticate with `GCP_ACCESS_TOKEN` or `GOOGLE_APPLICATION_CREDENTIALS`. The query sums `cost` plus credits for `usage_start_time` inside the window. Identifiers are checked against a fixed pattern before they are interpolated. The export currency is treated as the budget currency; align them or the figures will be mislabeled. The action records that assumption in the warnings.

## Windows and currency

A 28–31 day window is a calendar month. Any other length requires `normalize_to_monthly=true`, which scales by `30.4375 / days`. Cross-currency lines convert only through `fx_rates`, a map of source currency to budget-currency multiplier. A missing rate fails the run.
