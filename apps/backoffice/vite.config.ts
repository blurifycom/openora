import { defineConfig } from 'vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

// Force one physical copy of each singleton so React contexts (eg the TanStack
// QueryClient) dedupe. The workspace resolves more than one physical
// react / react-query (peer-dep version skew); without this the provider inside
// @oss/react-sdk and the consumer read different module instances -> "No
// QueryClient set". Vite equivalent of the Next apps' resolveAlias/webpack alias.
const SINGLETONS = ['@tanstack/react-query', 'react', 'react-dom'] as const;
const alias = Object.fromEntries(
  SINGLETONS.map((pkg) => [pkg, dirname(require.resolve(`${pkg}/package.json`))]),
);

export default defineConfig({
  resolve: {
    dedupe: [...SINGLETONS],
    alias,
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
  ],
});
