# TeamSync demo — four-role boundaries

This small runnable app demonstrates the repository layout the TeamSync roles
map onto, and gives the integration suite something real to prove
compatibility across components:

```
services/integrations/   → services role: external API adapters, normalization
apps/backend/            → backend role: HTTP API, composition
apps/frontend/           → frontend role: rendering, API consumption
packages/contracts/      → shared contract (validators) — coordinated by all
tests/integration/       → qa role: cross-component integration test
```

Run the backend: `node demo/apps/backend/server.mjs 8787`, then open
`http://localhost:8787`-served `apps/frontend/index.html` (or run the
integration test: `npm test -- tests/integration/demo.test.ts`).

The integration test starts the real backend, calls the real API, and
validates every payload against `packages/contracts/contracts.mjs` — exactly
the cross-role compatibility the CI gate protects when teammates work in
parallel.
