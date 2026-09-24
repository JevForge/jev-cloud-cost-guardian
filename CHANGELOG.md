# Changelog

## [Unreleased]

## [0.7.0]

### Added

* `include_resources` / `exclude_resources` globs (address, resource_type, or service). Filtered lines remain in findings with `RESOURCE_EXCLUDED` and do not affect budget totals.

## [0.6.0]

### Changed

* Moved the Jev provider/normalize contract into `src/core/` (vendored core; future `@jevforge/core`). `src/jev/*` re-exports for compatibility.

## [0.5.0]

### Added

* Optional `decision_json_path` and `sarif_path` inputs to write full decision JSON and SARIF 2.1 (findings never omitted).
* Matching outputs echo the paths when written for use with `actions/upload-artifact`.

## [0.4.0]

### Added

* Explicit `baseline_path` input/config and `require_baseline` gate for projected scope.
* Reason codes `EXPLICIT_BASELINE` and `BASELINE_FROM_BILLING` when a baseline is present.

## [0.3.0]

### Added

* Optional `budgets[]` rules in `.jev/config.yml` (environment / path glob / service) with most-specific match.
* Output `budget_rule` naming the matched rule; `budget_monthly` input remains the global fallback.

## [0.2.0]

### Added

* Optional Check Run (`create_check_run`, default true) and managed `jev:cost:*` labels (`apply_labels`).
* Allowed effects now include `check-run` and `apply-labels` (still never mutate infrastructure).

## [0.1.1] - 2026-09-24

### Changed

* Professional open-source documentation polish (README, templates, security, examples).
* Clearer `action.yml` defaults and Marketplace-oriented description (≤125 characters).
* Prefixed runtime logs and top-level errors with `[JEV Cloud Cost Guardian]`.

## [0.1.0] - 2026-09-24

### Added

* Initial public release of JEV Cloud Cost Guardian.
* Typed Jev decision over normalized estimates, Infracost, Terraform plans, Kubernetes manifests, Kubecost, AWS Cost Explorer, Azure Cost Management, and GCP BigQuery billing exports.
* Deterministic policy keeps every cost line visible and can only tighten `approve` or `warn`.
* Floating major tag `v0` and release `v0.1.0`.
