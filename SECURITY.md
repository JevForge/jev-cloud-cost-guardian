# Security Policy

## Supported versions

Security fixes are applied to the latest release on the `v0` line.

## Reporting a vulnerability

Do **not** open a public Issue for secrets exposure, auth bypass, or other sensitive security problems.

Use GitHub’s private vulnerability reporting for this repository when available:

**Security → Report a vulnerability**

If private reporting is unavailable, contact a JevForge organization owner through GitHub without including secrets in the message body.

**Never** send API keys, tokens, credentials, or private billing exports in reports.

## Hardening notes (this Action)

- Cost evidence paths must stay inside `GITHUB_WORKSPACE`.
- Secrets (`AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, `JEV_CUSTOM_API_KEY`, cloud credentials, `GITHUB_TOKEN`) must never be logged or written to outputs.
- Errors are redacted before `core.setFailed`.
- Jev responses are validated against Zod schemas. Arbitrary strings never become shell commands, paths, or cloud mutations.
- Resource addresses are hashed when `redact_resource_names` is true (default).
- The Action does not run Terraform, kubectl, or any cloud mutation API.
- GCP billing table identifiers are validated before SQL interpolation.
- Do not silently fall back across `jev_provider` values; misconfiguration fails closed.
- Use the minimum `GITHUB_TOKEN` permissions. Enable PR comments only when needed.
