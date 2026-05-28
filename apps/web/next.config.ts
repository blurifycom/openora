import type { NextConfig } from 'next';
import { createRequire } from 'node:module';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve singletons to a single physical path so React contexts (eg the
// TanStack QueryClient) dedupe. The workspace currently resolves more than one
// physical react / react-query (version skew), and without this the provider
// and consumer read different module instances -> "No QueryClient set".
const SINGLETONS = ['@tanstack/react-query', 'react', 'react-dom'] as const;
const absolute = Object.fromEntries(
  SINGLETONS.map((pkg) => [pkg, dirname(require.resolve(`${pkg}/package.json`))]),
);
const turboAlias = Object.fromEntries(
  Object.entries(absolute).map(([k, v]) => {
    const rel = relative(here, v);
    return [k, rel.startsWith('.') ? rel : `./${rel}`];
  }),
);

const nextConfig: NextConfig = {
  // 'standalone' emits a minimal node_modules tree under .next/standalone so the
  // Docker image can run `node .next/standalone/apps/web/server.js`.
  output: 'standalone',
  transpilePackages: ['@oss/react-pages', '@oss/ui-provider-contract', '@oss/ui-provider-daisyui'],
  ...(process.env.NEXT_OUTPUT_FILE_TRACING_ROOT
    ? { outputFileTracingRoot: process.env.NEXT_OUTPUT_FILE_TRACING_ROOT }
    : {}),
  turbopack: {
    resolveAlias: turboAlias,
  },
  webpack: (config) => {
    config.resolve.alias = { ...(config.resolve.alias ?? {}), ...absolute };
    return config;
  },
};

export default nextConfig;
