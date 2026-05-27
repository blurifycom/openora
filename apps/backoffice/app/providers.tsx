'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { ApiClientProvider, UIProvider, UIPluginProvider, type UIPlugin } from '@oss/react-sdk';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Define plugins at module scope - never inline in JSX.
// A new array reference on every render re-runs buildRegistry and resets error boundaries.
const plugins: UIPlugin[] = [];

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={{ baseUrl: API_URL }}>
        <UIPluginProvider plugins={plugins}>
          <UIProvider value={daisyuiProvider}>{children}</UIProvider>
        </UIPluginProvider>
      </ApiClientProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
