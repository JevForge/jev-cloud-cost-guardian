# Contributing

Thanks for contributing to **JEV Cloud Cost Guardian**.

## Requirements

- Node.js **24+**
- npm

## Setup

```bash
git clone https://github.com/JevForge/jev-cloud-cost-guardian.git
cd jev-cloud-cost-guardian
npm ci
```

## Develop

```bash
npm test
npm run typecheck
npm run build
```

Or run everything:

```bash
npm run all
```

`dist/index.js` is the shipped Action entrypoint. Rebuild and commit `dist/` after TypeScript changes so consumers do not run `npm install`.

## Guidelines

- Keep public identifiers, runtime messages, and docs in **English**.
- Do not commit secrets, `.env`, cloud credentials, or private billing exports.
- Prefer additive schema/output changes; treat Action outputs as a SemVer contract.
- Never add a path that turns a missing Jev response into `approve`.
- Open Issues for bugs/features; open PRs against `main`.
- Never paste credentials into Issues, PRs, or logs.

## Project layout

| Path | Role |
| ---- | ---- |
| `src/collectors` | Cost sources, aggregation, config |
| `src/jev` | Jev providers and normalization |
| `src/decision` | Deterministic policy rails |
| `src/executors` | Allowed effects (summary/comment) |
| `tests` | Unit, contract, and integration tests |
| `examples` | Workflow and estimate samples |
| `docs` | Decision contract and connectors |

## Pull requests

Use the PR template checklist. Include a short summary of user-facing impact.
