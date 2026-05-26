'use client';

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientProvider, UIProvider, ThemeProvider } from '@oss/react-sdk';
import { shadcnProvider } from '@oss/ui-provider-shadcn';
import '@oss/react-sdk/styles.css';

// The UI side of a consumer. Drop this into a Next app's app/providers.tsx and wrap
// your root layout's {children} with <Providers>. The page bodies shipped by
// @oss/react-sdk (eg DashboardPage) render inside these contexts.
//
// Provider order, outermost -> innermost:
//   QueryClientProvider  - TanStack Query cache the SDK hooks use
//   ApiClientProvider    - the typed client; point baseUrl at your API
//   ThemeProvider        - design tokens; `preset` is a key from themePresets
//   UIProvider           - the headless UI adapter (swap shadcn for your own here)
//
// (UIPluginProvider wraps the innermost layer when you have defineUIPlugin
// contributions - omitted here for brevity. See ADR-0006.)
//
// Cross-workspace `link:` needs a dedup alias in next.config.ts for react, react-dom,
// and @tanstack/react-query so React contexts resolve to one physical copy. See
// docs/downstream-consumer.md and the working ../consumer/apps/web/next.config.ts.

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={{ baseUrl }}>
        <ThemeProvider preset="midnightSapphire">
          <UIProvider value={shadcnProvider}>{children}</UIProvider>
        </ThemeProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
