// Run from the repo root (`test:mutation` does the cd) so the sandbox holds both test tiers.
//
// Stryker only writes its incremental file when a run finishes, so a run that outgrows the job's
// time limit loses everything and starts over the next night. At about 7 mutants a minute after a
// 30 minute initial run, one job fits about 2200 mutants, so each shard stays under that. A file
// that grows past it gets split here, by line range when it is one file. `.github/workflows/mutation.yml`
// runs one job per shard and lists these names.
const WALLET_SERVICE = 'wallet/service/wallet.service.ts';
const WALLET_RAILS = [
  'wallet/service/reconciliation.service.ts',
  'wallet/service/wallet-commands.service.ts',
  'wallet/service/on-ramp.service.ts',
];
const COMPLIANCE_CORE = [
  'compliance/service/compliance.service.ts',
  'compliance/service/kyc.service.ts',
  'compliance/service/rg.service.ts',
];
const AUDIT_PLUGIN = 'audit/plugin.ts';
const IDENTITY_SERVICE = 'pam/identity/service/identity.service.ts';

const SHARDS = {
  // Split between two methods: a mutant that spans the boundary is in neither range.
  'wallet-service-a': [`${WALLET_SERVICE}:1-2295`],
  'wallet-service-b': [`${WALLET_SERVICE}:2296-99999`],
  'wallet-rails': WALLET_RAILS,
  'wallet-rest': [
    'wallet/**/*.ts',
    `!${WALLET_SERVICE}`,
    ...WALLET_RAILS.map((file) => `!${file}`),
  ],
  'compliance-core': COMPLIANCE_CORE,
  'compliance-rest': ['compliance/**/*.ts', ...COMPLIANCE_CORE.map((file) => `!${file}`)],
  'audit-plugin': [AUDIT_PLUGIN],
  'audit-rest': ['audit/**/*.ts', `!${AUDIT_PLUGIN}`],
  'identity-service': [IDENTITY_SERVICE],
  'identity-rest': ['pam/identity/**/*.ts', `!${IDENTITY_SERVICE}`],
  'promo-gamification': ['promo/gamification/**/*.ts'],
  'promo-bonus': ['promo/bonus/**/*.ts'],
};

const shard = process.env['MUTATION_SHARD'] ?? 'wallet-service-a';
const paths = SHARDS[shard];
if (!paths) {
  throw new Error(`Unknown MUTATION_SHARD "${shard}": ${Object.keys(SHARDS).join(', ')}`);
}
const reports = `packages/core/reports/${shard}`;
const toRepoPath = (path) =>
  path.startsWith('!') ? `!packages/core/src/${path.slice(1)}` : `packages/core/src/${path}`;

export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'packages/core/vitest.mutation.config.ts',
    // Plugins load through `import(path)`, which vitest's related-files graph cannot see, so
    // with this on a mutant in plugin code runs zero tests and is reported as survived.
    related: false,
    // A test calls `process.chdir()`, which threads do not support.
    pool: 'forks',
  },
  checkers: ['typescript'],
  tsconfigFile: 'packages/core/tsconfig.json',
  ignorePatterns: ['/packages/core/reports', '/.worktrees', '/.claude'],
  mutate: [
    ...paths.map(toRepoPath),
    '!packages/core/src/**/__tests__/**',
    '!packages/core/src/**/contract/**',
    '!packages/core/src/**/schema/**',
    '!packages/core/src/**/drizzle/**',
    '!packages/core/src/**/seed/**',
    '!packages/core/src/**/{index,migrate,server}.ts',
    '!packages/core/src/**/drizzle.config.ts',
    '!packages/core/src/**/*.{test,spec}.ts',
  ],
  // Static mutants run every test: 19% of the mutants took 98% of the estimated time.
  ignoreStatic: true,
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: { fileName: `${reports}/mutation.html` },
  jsonReporter: { fileName: `${reports}/mutation.json` },
  incremental: true,
  incrementalFile: `${reports}/stryker-incremental.json`,
  coverageAnalysis: 'perTest',
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
  // `packages/testing/src/redis.ts` has two Redis slices for this tier.
  concurrency: 2,
  timeoutMS: 60000,
  dryRunTimeoutMinutes: 90,
};
