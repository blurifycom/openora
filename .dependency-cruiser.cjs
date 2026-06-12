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
      name: 'no-cross-module',
      severity: 'error',
      comment:
        "A feature module must not depend on another module's code. Communicate via events (EVENT_BUS), a synchronous command port, or the read-only @oss/modules/<group>/<name>/schema subpath. See AGENTS.md > Dependency rules.",
      from: { path: '^packages/modules/([^/]+/[^/]+)/' },
      to: {
        path: '^packages/modules/[^/]+/[^/]+/',
        // same module is fine; the sanctioned cross-module /schema read is
        // allowed here (it is a WARNING in the oxlint twin, not a hard error).
        pathNot: ['^packages/modules/$1/', '/src/schema/'],
      },
    },
    {
      name: 'no-platform-to-module',
      severity: 'error',
      comment:
        'platform/* must not import feature modules or UI. api-runtime (composition root) and testing (test composition root) are the only exceptions. See AGENTS.md > Dependency rules.',
      from: {
        path: '^packages/platform/',
        pathNot: '^packages/platform/(api-runtime|testing)/',
      },
      to: { path: '^(packages/modules/|packages/ui/)' },
    },
    {
      name: 'no-contracts-to-runtime',
      severity: 'error',
      comment:
        'contracts/* may import only other contracts (and zod). No modules, platform runtime, sdks, ui, or apps. See AGENTS.md > Dependency rules.',
      from: { path: '^packages/contracts/' },
      to: { path: '^(apps/|packages/)', pathNot: '^packages/contracts/' },
    },
    {
      name: 'no-core-to-addon',
      severity: 'error',
      comment:
        'The core OSS build must never depend on an add-on package. packages/{modules,platform,contracts,sdks}/* may not import packages/addons/* (@oss-addons/*). Only the composition roots under apps/* wire add-on in (via extensions.config.ts + the createApp contract merge). This is the guarantee that an add-on module can be extracted without breaking core. See docs/adr/ADR-0020-editions-and-add-on-modules.md.',
      from: { path: '^packages/(modules|platform|contracts|sdks)/' },
      to: { path: '^packages/addons/' },
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
      name: 'no-app-into-module-internals',
      severity: 'error',
      comment:
        'apps/api wires modules only through extensions.config.ts (the plugin registry). A direct module-file import from apps/api/src/* is forbidden. See AGENTS.md > Dependency rules.',
      from: {
        path: '^apps/api/src/',
        pathNot: '^apps/api/src/extensions/',
      },
      to: { path: '^packages/modules/[^/]+/[^/]+/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Scan first-party source only; skip compiled output and (test|spec) files -
    // tests legitimately wire several modules together (the oxlint twin disables
    // the cross-module rules for *.test.ts / *.spec.ts for the same reason).
    exclude: { path: '(/dist/|/node_modules/|[.](test|spec)[.]ts$)' },
    includeOnly: '^(apps|packages)/',
    tsPreCompilationDeps: true,
  },
};
