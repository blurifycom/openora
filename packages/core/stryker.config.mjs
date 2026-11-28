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
  thresholds: { high: 80, low: 65, break: 55 },
  vitest: {
    configFile: 'packages/core/vitest.mutation.config.ts',
    related: false,
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
  ignoreStatic: true,
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: { fileName: `${reports}/mutation.html` },
  jsonReporter: { fileName: `${reports}/mutation.json` },
  incremental: true,
  incrementalFile: `${reports}/stryker-incremental.json`,
  coverageAnalysis: 'perTest',
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
  concurrency: 2,
  timeoutMS: 60000,
  dryRunTimeoutMinutes: 90,
};
