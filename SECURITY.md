# Security policy

## Reporting

Report vulnerabilities privately to the JevForge maintainers. Do not open a public issue that includes credentials, billing account identifiers, or cost exports from a private environment.

## Runtime guarantees

- The action reads cost evidence and writes GitHub outputs, a job summary, and an optional pull request comment.
- It does not run Terraform, kubectl, or any cloud mutation API.
- Jev text is not interpolated into a shell, a path, or a cloud operation.
- Secrets are read from the environment and are redacted from errors and from the payload sent to Jev.
- Resource addresses are hashed when `redact_resource_names` is true (the default).
- Connector queries are built by this action. Billing table identifiers are validated before they are placed in SQL.

## Permissions

Default the workflow token to `contents: read`. Grant `pull-requests: write` only when `comment_on_github` is true.
