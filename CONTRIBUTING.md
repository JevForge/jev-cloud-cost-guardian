# Contributing

Development uses Node.js 24.

```bash
npm ci
npm run all
```

`npm run all` typechecks, runs the coverage suite, and rebuilds `dist/index.js`. Commit the rebuilt `dist/` with source changes so consumers do not run `npm install`.

Add tests for schema rejection, malformed Jev answers, missing credentials, and any new cost source. Do not add a code path that turns a missing Jev response into `approve`.

Do not commit `.env` files, cloud credentials, or private billing exports.
