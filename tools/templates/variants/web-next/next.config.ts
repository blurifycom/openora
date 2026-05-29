import type { NextConfig } from 'next';
import { createRequire } from 'node:module';
import { dirname, relative, sep } from 'node:path';
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

// The @oss/* packages are linked from a sibling checkout outside this repo. Point
// Turbopack (and webpack) at the directory that contains BOTH repos, otherwise the
// bundler refuses to resolve/compile modules across the link: boundary.
function commonAncestor(a: string, b: string): string {
  const pa = a.split(sep);
  const pb = b.split(sep);
  const out: string[] = [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const seg = pa[i];
    if (seg !== undefined && seg === pb[i]) out.push(seg);
    else break;
  }
  return out.join(sep) || sep;
}
let workspaceRoot = here;
try {
  workspaceRoot = commonAncestor(here, require.resolve('@oss/react-pages'));
} catch {
  // @oss/* not resolvable yet (run pnpm install + pnpm build:oss); fall back.
}

const nextConfig: NextConfig = {
  transpilePackages: ['@oss/react-pages', '@oss/ui-provider-contract', '@oss/ui-provider-daisyui'],
  experimental: { externalDir: true },
  turbopack: {
    root: workspaceRoot,
    resolveAlias: turboAlias,
  },
  webpack: (config) => {
    config.resolve.alias = { ...(config.resolve.alias ?? {}), ...absolute };
    return config;
  },
};

export default nextConfig;
