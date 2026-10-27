# Shared contracts

This directory is the **single source of truth for cross-role API contracts**:
shared TypeScript types, schemas, and message shapes used by `apps/backend`,
`apps/frontend`, and `services/`.

## Why it exists

Role path ownership is advisory — but contracts are where independent changes
most often collide. When you need to change a contract:

1. Propose the change in a small PR touching only `packages/contracts/`.
2. Mention the teammates whose roles consume it (backend ↔ frontend ↔ services).
3. Let CI validate; auto-merge lands it; everyone rebases their task branch
   with `teamsync sync`.

## Conventions

- Keep runtime code here minimal: types + small validators only.
- No framework imports. No secrets. No Node-only or DOM-only APIs in shared files.
- Every exported contract gets a short doc comment.
