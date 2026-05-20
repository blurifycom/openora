import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 'standalone' emits a minimal node_modules tree under .next/standalone so the
  // Docker image can run `node .next/standalone/apps/backoffice/server.js`
  // without copying the full pnpm store.
  output: 'standalone',
  transpilePackages: ['@oss/react-sdk', '@oss/ui-provider-contract', '@oss/ui-provider-shadcn'],
  // outputFileTracingRoot points at the workspace root so the tracer follows
  // symlinks into linked @oss/* packages. Only set when provided (Next rejects
  // an explicit `undefined` under exactOptionalPropertyTypes).
  ...(process.env.NEXT_OUTPUT_FILE_TRACING_ROOT
    ? { outputFileTracingRoot: process.env.NEXT_OUTPUT_FILE_TRACING_ROOT }
    : {}),
};

export default nextConfig;
