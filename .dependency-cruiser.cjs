/**
 * Whole-graph architectural boundary gate (deterministic - no agent in the loop).
 *
 * This complements, it does not replace, the oxlint `oss-boundaries/*` plugin.
 * That plugin matches IMPORT-SPECIFIER STRINGS per file with zero module
 * resolution (by design - see tools/lint/oxlint-boundaries-plugin.mjs). These rules
 * run against the RESOLVED dependency graph, so they also catch what the string
 * matcher cannot: transitive edges, re-export/barrel laundering, dynamic
 * `import()`, and relative paths that dodge the `@openora/` specifier prefix.
 *
 * The layering mirrors AGENTS.md > Dependency rules. Keep the two enforcers in
 * sync: a rule added here should have a string-level twin in the oxlint plugin
 * (fast per-edit feedback) and vice versa.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */

// Package self-reference subpaths (@openora/core/<domain>/...) resolve through the
// exports map to dist/, which is excluded - without a paths mapping those edges are
// INVISIBLE to the graph and every rule below silently skips them. Reuse the canonical
// paths from packages/core/tsconfig.json (rebased onto the repo root, extends dropped -
// the ts parser can't follow it from here) via a flat tsconfig generated at load time.
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const corePaths = require('./packages/core/tsconfig.json').compilerOptions.paths;
const rebased = Object.fromEntries(
  Object.entries(corePaths).map(([spec, targets]) => [
    spec,
    targets.map((t) => t.replace(/^\.\//, './packages/core/')),
  ]),
);
const generatedTsConfigDir = join(__dirname, 'node_modules', '.cache');
const generatedTsConfig = join(generatedTsConfigDir, 'dependency-cruiser-tsconfig.json');
mkdirSync(generatedTsConfigDir, { recursive: true });
writeFileSync(
  generatedTsConfig,
  // files/baseUrl are tsconfig-relative: point back at the repo root from node_modules/.cache
  JSON.stringify({
    files: ['../../extensions.config.ts'],
    compilerOptions: { baseUrl: '../..', paths: rebased },
  }),
);

// The money service and the platform service each take their tables with them (ADR-0063), so
// neither side reads the other's schema; they meet through ports.
// Shared modules (audit, mail, fx) and chat (no-chat-schema-outside-chat) sit in neither list.
const MONEY_MODULES = '^packages/core/src/(?:wallet|promo|casino/gaming|sportsbook)/';
const MONEY_SCHEMA =
  '^packages/core/src/(?:wallet|promo/bonus|promo/gamification|casino/gaming|sportsbook/betting)/schema/';
const PLATFORM_MODULES =
  '^packages/core/src/(?:pam|compliance|analytics|admin-console|engagement|iam|cms|casino/lobby)/';
const PLATFORM_SCHEMA =
  '^packages/core/src/(?:pam/identity|pam/profile|pam/tag|pam/player-note|compliance|engagement/notifications|engagement/support-chat|iam|cms|casino/lobby)/schema/';
// Platform readers of the casino game catalog, which still lives in the gaming schema. They
// leave this list when the catalog splits from the round ledger into a platform module.
const CASINO_CATALOG_READERS = [
  '^packages/core/src/casino/lobby/service/lobby[.]service[.]ts$',
  '^packages/core/src/compliance/service/compliance[.]service[.]ts$',
];

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
        'The contracts zone (@openora/core/contracts = packages/core/src/contracts) is isomorphic - it must not depend on the node engine (@openora/core/server) (a folded domain is covered by no-core-to-domain). It holds only composeContract/healthContract, base zod schemas, and ports/tokens. See AGENTS.md > Dependency rules and ADR-0021/0025.',
      from: { path: '^packages/core/src/contracts' },
      to: { path: '^packages/core/src/server' },
    },
    {
      name: 'no-react-to-runtime',
      severity: 'error',
      comment:
        'The react zone (@openora/core/react = packages/core/src/react) is browser glue - it must not depend on the node engine (@openora/core/server = packages/core/src/server). Importing it pulls Drizzle/Hono/node into the client bundle. Keep it domain-free + server-free. See ADR-0025.',
      from: { path: '^packages/core/src/react' },
      to: { path: '^packages/core/src/server' },
    },
    {
      name: 'no-core-to-domain',
      severity: 'error',
      comment:
        'The @openora/core engine zones (contracts/server/react) must never depend on a folded domain (packages/core/src/<domain> = any core/src dir other than the engine zones). createApp is domain-agnostic (DI: the consumer injects PAM identity + the tenant resolver); demo seeding lives in @openora/testing. Post-fold twin of the old packages/core -> packages/domains rule. See ADR-0024/0025.',
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
        path: '^packages/core/src/(?!contracts/|server/|react/|scripts/|common/)[^/]+/',
        pathNot: ['^packages/core/src/$1/', '/schema/'],
      },
    },
    {
      name: 'no-chat-schema-outside-chat',
      severity: 'error',
      comment:
        'Chat, chat-commands and social move to their own database together, so no other module may read their tables, even through the read-only /schema subpath no-cross-domain allows. A money transfer in chat asks CHAT_TRANSFER_CHECK; a block list comes from CHAT_BLOCK_READER.',
      from: {
        path: '^packages/core/src/',
        pathNot: [
          '^packages/core/src/engagement/(?:chat|chat-commands|social)/',
          '^packages/core/src/scripts/seed-demo-data[.]ts$',
        ],
      },
      to: { path: '^packages/core/src/engagement/(?:chat|chat-commands|social)/schema/' },
    },
    {
      name: 'no-platform-schema-in-money',
      severity: 'error',
      comment:
        'A money module (wallet, promo, casino/gaming, sportsbook) moves to the money database, so it reads no platform table, not even through the read-only /schema subpath: it asks a platform port (IDENTITY_READER, PLAYER_TAGS, ...). See ADR-0063.',
      from: { path: MONEY_MODULES },
      to: { path: PLATFORM_SCHEMA },
    },
    {
      name: 'no-money-schema-in-platform',
      severity: 'error',
      comment:
        'A platform module reads no money table, not even through the read-only /schema subpath: it asks a money port (WALLET_READER, MONEY_REPORTING, PLAYER_RANK_READER, ...), which money-remote binds over the network when MONEY_SERVICE_URL is set. See ADR-0063.',
      from: { path: PLATFORM_MODULES, pathNot: CASINO_CATALOG_READERS },
      to: { path: MONEY_SCHEMA },
    },
    {
      name: 'no-deep-package-import',
      severity: 'error',
      comment:
        'Import a sibling workspace package through its package entry, never its src/dist internals. @openora/core is exempt: its exports map is a wide set of documented subpaths that all resolve into src/ through the generated paths mapping, so a "deep" path there is the public surface (its internals are policed by the zone rules above instead).',
      from: { path: '^(?:apps|packages)/([^/]+)/' },
      to: {
        path: '^packages/(?!core/)[^/]+/(?:src|dist)/',
        pathNot: ['^packages/$1/', '^packages/[^/]+/(?:src/)?index\\.(?:ts|tsx|js|mjs)$'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Scan first-party source only; skip compiled output, (test|spec) files and test
    // support under __tests__/ - tests legitimately wire several domains together (the
    // oxlint twin disables the cross-domain rule for *.test.ts / *.spec.ts for the same reason).
    exclude: { path: '(/dist/|/node_modules/|/__tests__/|[.](test|spec)[.]ts$)' },
    includeOnly: '^(apps|packages)/',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: generatedTsConfig },
    // ~8s cold on 3.3k modules; the cache cuts unchanged re-runs (pre-commit) to <1s.
    // Invalidates on config, option, or file-set change ('metadata' strategy uses git).
    cache: true,
  },
};
