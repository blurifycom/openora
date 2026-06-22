/**
 * Whole-graph architectural boundary gate (deterministic - no agent in the loop).
 *
 * This complements, it does not replace, the oxlint `oss-boundaries/*` plugin.
 * That plugin matches IMPORT-SPECIFIER STRINGS per file with zero module
 * resolution (by design - see tools/oxlint-boundaries-plugin.mjs). These rules
 * run against the RESOLVED dependency graph, so they also catch what the string
 * matcher cannot: transitive edges, re-export/barrel laundering, dynamic
 * `import()`, and relative paths that dodge the `@blurifycom/` specifier prefix.
 *
 * The layering mirrors AGENTS.md > Dependency rules. Keep the two enforcers in
 * sync: a rule added here should have a string-level twin in the oxlint plugin
 * (fast per-edit feedback) and vice versa.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependency. Break the cycle - extract a shared module, invert a dependency, or move the type to a contracts package.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-contracts-to-runtime',
      severity: 'error',
      comment:
        'The contracts zone (@blurifycom/core/contracts = packages/core/src/contracts) is isomorphic - it must not depend on the node engine (@blurifycom/core/server) or an add-on (a folded domain is covered by no-core-to-domain). It holds only composeContract/healthContract, base zod schemas, and ports/tokens. See AGENTS.md > Dependency rules and ADR-0021/0025.',
      from: { path: '^packages/core/src/contracts' },
      to: { path: '^(packages/core/src/server|packages/addons/)' },
    },
    {
      name: 'no-react-to-runtime',
      severity: 'error',
      comment:
        'The react zone (@blurifycom/core/react = packages/core/src/react) is browser glue - it must not depend on the node engine (@blurifycom/core/server = packages/core/src/server). Importing it pulls Drizzle/Hono/node into the client bundle. Keep it domain-free + server-free. See ADR-0025.',
      from: { path: '^packages/core/src/react' },
      to: { path: '^packages/core/src/server' },
    },
    {
      name: 'no-core-to-addon',
      severity: 'error',
      comment:
        'The published core (@blurifycom/core = packages/core) must never depend on an add-on package (packages/addons/*). Add-on is wired in only by the composition roots under apps/* (extensions.config.ts + the editions contract merge) and the @blurifycom/testing harness. This keeps every add-on extractable. See ADR-0021/0025.',
      from: { path: '^packages/core/' },
      to: { path: '^packages/addons/' },
    },
    {
      name: 'no-core-to-domain',
      severity: 'error',
      comment:
        'The @blurifycom/core engine zones (contracts/server/react) must never depend on a folded domain (packages/core/src/<domain> = any core/src dir other than the engine zones). createApp is domain-agnostic (DI: the consumer injects PAM identity + the tenant resolver); demo seeding lives in @blurifycom/testing. Post-fold twin of the old packages/core -> packages/domains rule. See ADR-0024/0025.',
      from: { path: '^packages/core/src/(contracts|server|react)/' },
      to: { path: '^packages/core/src/(?!contracts/|server/|react/|scripts/)[^/]+/' },
    },
    {
      name: 'no-cross-domain',
      severity: 'error',
      comment:
        'A folded domain (packages/core/src/<domain>) must not depend on a sibling domain - the single rule of ADR-0024, now enforced intra-package. Couple only through the foundation: a read-only /schema subpath, a command/adapter port (eg WALLET_COMMANDS), a domain event, or a shared contract via the composition root. This whole-graph twin catches relative-path / barrel laundering the oxlint string rule (no-cross-core-domain) cannot.',
      from: { path: '^packages/core/src/(?!contracts/|server/|react/|scripts/)([^/]+)/' },
      to: {
        path: '^packages/core/src/(?!contracts/|server/|react/|scripts/)[^/]+/',
        pathNot: ['^packages/core/src/$1/', '/schema/'],
      },
    },
    {
      name: 'no-cross-addon',
      severity: 'error',
      comment:
        'An add-on package must not depend on another add-on package (same rule as no-cross-module). Communicate via events, a command port, or the read-only /schema subpath. Keeping add-on packages mutually independent is what lets each one be shipped separately/extracted on its own.',
      from: { path: '^packages/addons/([^/]+)/' },
      to: {
        path: '^packages/addons/[^/]+/',
        pathNot: ['^packages/addons/$1/', '/src/schema/'],
      },
    },
    {
      name: 'no-cross-extension',
      severity: 'error',
      comment:
        'An overlay extension must not import another extension. Cross-extension communication goes through the event bus. See apps/api/src/extensions/AGENTS.md.',
      from: { path: '^apps/api/src/extensions/([^/]+)/' },
      to: {
        path: '^apps/api/src/extensions/[^/]+/',
        pathNot: '^apps/api/src/extensions/$1/',
      },
    },
    {
      name: 'no-app-into-addon-internals',
      severity: 'error',
      comment:
        'apps/api wires add-ons only through extensions.config.ts (the plugin registry). A direct add-on-file import from apps/api/src/* is forbidden. See AGENTS.md > Dependency rules.',
      from: {
        path: '^apps/api/src/',
        pathNot: '^apps/api/src/extensions/',
      },
      to: { path: '^packages/addons/[^/]+/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Scan first-party source only; skip compiled output and (test|spec) files -
    // tests legitimately wire several add-ons together (the oxlint twin disables
    // the cross-addon rules for *.test.ts / *.spec.ts for the same reason).
    exclude: { path: '(/dist/|/node_modules/|[.](test|spec)[.]ts$)' },
    includeOnly: '^(apps|packages)/',
    tsPreCompilationDeps: true,
  },
};
