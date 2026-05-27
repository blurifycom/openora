import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

// Resolve singletons to one physical path so React contexts (eg the TanStack
// QueryClient) dedupe across the cross-workspace link: boundary. Without this the
// provider (inside the linked @oss/react-sdk) and the consumer read different
// module instances -> "No QueryClient set". This is the Vite equivalent of the
// Next template's resolveAlias/webpack alias. See ADR-0005.
const SINGLETONS = ['@tanstack/react-query', 'react', 'react-dom'] as const;
const alias = Object.fromEntries(
  SINGLETONS.map((pkg) => [pkg, dirname(require.resolve(`${pkg}/package.json`))]),
);

export default defineConfig({
  resolve: {
    // dedupe is belt-and-braces alongside the explicit alias above.
    dedupe: [...SINGLETONS],
    alias,
  },
  // The @oss/* packages are linked from a sibling checkout outside this repo; Vite
  // must be allowed to read source/dist across the link: boundary.
  server: { fs: { allow: ['..', '../..', '../../..'] } },
  plugins: [
    tanstackStart({ customViteReactPlugin: true }),
    viteReact(),
  ],
});
