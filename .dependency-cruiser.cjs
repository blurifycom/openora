/**
 * Whole-graph architectural boundary gate (deterministic - no agent in the loop).
 *
 * This complements, it does not replace, the oxlint `oss-boundaries/*` plugin.
 * That plugin matches IMPORT-SPECIFIER STRINGS per file with zero module
 * resolution (by design - see tools/oxlint-boundaries-plugin.mjs). These rules
 * run against the RESOLVED dependency graph, so they also catch what the string
 * matcher cannot: transitive edges, re-export/barrel laundering, dynamic
 * `import()`, and relative paths that dodge the `@oss/` specifier prefix.
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
        'contracts/* may import only other contracts (and zod). No modules, platform runtime, sdks, ui, or apps. The one exception is the @oss/orpc-contract aggregator reading add-on `/contract` slices (the read-only subpath that owns each route contract), which it composes into the SDK`s typed client. See AGENTS.md > Dependency rules and ADR-0021.',
      from: { path: '^packages/contracts/' },
      to: {
        path: '^(apps/|packages/)',
        pathNot:
          '^packages/contracts/|^packages/addons/[^/]+/src/contract(/|$)|^packages/domains/[^/]+/src/contract(/|$)',
      },
    },
    {
      name: 'no-core-to-addon',
      severity: 'error',
      comment:
        'The core OSS build must never depend on an add-on package. packages/{platform,contracts,sdks}/* may not import packages/addons/* (@oss-addons/*). Exceptions: (1) the two composition roots under packages/platform/(api-runtime|testing)/, which read add-on /schema subpaths for seeding + tenant resolution; (2) the @oss/orpc-contract aggregator reading add-on `/contract` slices to compose the SDK typed client (oxlint pins this to orpc-contract only). Everything else wires add-on in only through the composition roots under apps/*. This keeps an add-on package extractable. See ADR-0021.',
      from: {
        path: '^packages/(platform|contracts|sdks|foundation)/',
        pathNot: '^packages/platform/(api-runtime|testing)/',
      },
      to: {
        path: '^packages/addons/',
        pathNot: '^packages/addons/[^/]+/src/contract(/|$)',
      },
    },
    {
      name: 'no-core-to-domain',
      severity: 'error',
      comment:
        'The core OSS build must never depend on a domain package. packages/{platform,contracts,sdks,foundation}/* may not import packages/domains/* (@oss/<domain>). Exceptions mirror no-core-to-addon: (1) the composition roots under packages/platform/(api-runtime|testing)/ read a domain`s /schema for seeding + tenant resolution; (2) the @oss/orpc-contract aggregator reads a domain`s /contract slice to compose the SDK typed client. A domain stays independently installable - everything else wires it in only through apps/*. See ADR-0024.',
      from: {
        path: '^packages/(platform|contracts|sdks|foundation)/',
        pathNot: '^packages/platform/(api-runtime|testing)/',
      },
      to: {
        path: '^packages/domains/',
        pathNot: '^packages/domains/[^/]+/src/contract(/|$)',
      },
    },
    {
      name: 'no-cross-domain',
      severity: 'error',
      comment:
        'A domain package must not depend on another domain package - the single rule of ADR-0024. Domains couple only through the foundation: a command/adapter port (eg WALLET_COMMANDS), a domain event, or a shared contract - never a direct import, not even a /schema read. This is what lets any subset of domains install on its own (PAM-only, casino-only). Stricter than no-cross-addon, which still allows /schema reads.',
      from: { path: '^packages/domains/([^/]+)/' },
      to: {
        path: '^packages/domains/[^/]+/',
        pathNot: '^packages/domains/$1/',
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
