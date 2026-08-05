---
description: 'Add an oRPC route stub to an overlay or local add-on. Args: <target> <GET|POST|PUT|PATCH|DELETE> <path>. Example: /scaffold-route promotions GET /active.'
---

Parse `$ARGUMENTS` as `<target> <method> <path>`.

First confirm the route does not already exist - `list-routes` (oss MCP) for the namespace, or
`list-routes` to confirm the route does not already exist.

Run `pnpm gen route <target> <method> <path>` in the repo root. The generator adds both a contract
procedure and a matching router handler - no inline Zod in the router.

After it generates:

1. Replace the placeholder `.output(z.object({}))` with the real input/output schemas (derive from
   existing schemas; never hand-write a type that a schema already defines).
2. Implement the handler in the target's router, delegating to a service method. Admin routes call
   `await adminGuard.assert(context)` first.
3. Audit any state-changing route (emit a domain event or `AUDIT_WRITER.record`).
4. `pnpm db:migrate` if a table changed, then `/check`.

Most consumer routes belong inside an overlay plugin - see **scaffold-plugin** / the **create-plugin**
skill. Use a local add-on only when the feature is a self-contained module.
