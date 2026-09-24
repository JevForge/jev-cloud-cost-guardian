# Decision contract

Jev chooses one of `approve`, `warn`, `block`, or `manual-review` through the typed evaluation API. Reason codes are assigned by this action from the cost evidence so a model cannot invent a code or a command.

## Valid decision

```json
{
  "decision": "warn",
  "confidence": 0.82,
  "reason_codes": ["APPROACHING_BUDGET", "PROD_ENVIRONMENT", "NEW_SPEND"],
  "currency": "USD",
  "environment": "production",
  "window": { "start": "2026-09-01", "end": "2026-10-01" },
  "baseline_monthly": 800,
  "delta_monthly": 120,
  "projected_monthly": 920,
  "budget_monthly": 1000,
  "budget_remaining": 80,
  "utilization": 0.92,
  "summary": "warn: projected 920.00 USD/month, delta 120.00, budget 1000.00 (92.0%), confidence 0.820",
  "explanation": "Jev decision is warn.",
  "provisional": false,
  "findings": [],
  "sources": ["infracost"],
  "unpriced_count": 0,
  "partial_count": 0
}
```

`findings` in a real result contains every collected cost line. An empty array is valid only when the report itself has no lines, which the loader rejects.

## Rejected responses

The schema rejects all of these. None of them become a workflow command.

- `{ "decision": "approve", "confidence": 1.2, "reason_codes": ["WITHIN_BUDGET"] }`
- `{ "decision": "terraform apply", "confidence": 0.9, "reason_codes": ["WITHIN_BUDGET"] }`
- `{ "decision": "approve", "confidence": 0.9, "reason_codes": [] }`
- `{ "decision": "approve", "confidence": -0.1, "reason_codes": ["WITHIN_BUDGET"] }`
- `{ "decision": "approve", "confidence": 0.9, "reason_codes": ["DROP_ALL_COSTS"] }`
- `{ "decision": "block", "confidence": 0.4, "reason_codes": ["EXCEEDS_BUDGET"], "shell": "terraform apply" }`

A typed answer whose choice is outside `approve | warn | block | manual-review` throws `SCHEMA_REJECTED` and fails the action.

## What Jev decides, and what the executor will not do

Jev returns the decision choice, a confidence score, and whether the estimates look incomplete. This action does not locally invent an `approve` when the provider is down.

After that choice is validated, the executor may only tighten it:

- `approve` becomes `manual-review` when confidence is below `min_confidence`, when Jev marks the estimates incomplete, when unpriced or partial lines are present, or when a projected budget has no baseline.
- `approve` and `warn` become `block` when scoped utilization is at or above `block_utilization` and `enforce_block_threshold` is true.
- A `block` or `manual-review` from Jev is never rewritten to `approve`.
- Findings are replaced with the collected lines. A shorter list is discarded and `COST_VISIBILITY_ENFORCED` is recorded.

Allowed effects are `set-outputs`, `write-summary`, `pull-request-comment`, and `fail-workflow`. The comment body is rendered from those fields. `dry_run` skips the comment.
