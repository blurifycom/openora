import type { NextConfig } from 'next';
import { createRequire } from 'node:module';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve singletons to one physical path so React contexts (eg the TanStack
// QueryClient) dedupe across the cross-workspace link: boundary. Without this the
// provider and consumer can read different module instances -> "No QueryClient set".
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
  transpilePackages: ['@oss/react-sdk', '@oss/ui-provider-contract', '@oss/ui-provider-shadcn'],
  turbopack: {
    resolveAlias: turboAlias,
  },
  webpack: (config) => {
    config.resolve.alias = { ...(config.resolve.alias ?? {}), ...absolute };
    return config;
  },
};

export default nextConfig;
