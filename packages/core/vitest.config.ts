import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**', 'node_modules/**', 'src/**/*.int.{test,spec}.ts'],
    // Deliberately left isolated. `isolate: false` cuts this tier from ~53s to ~16s by
    // sharing one module graph across files, but a shared graph defeats `vi.mock` - a
    // file that already imported the real module wins, and auth.test.ts/migrate.test.ts
    // fail depending on how files group onto workers. It also buys no CI wall-clock:
    // this tier runs concurrently underneath the much longer integration tier.
  },
});
