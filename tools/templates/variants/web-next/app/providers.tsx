'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientProvider, UIProvider, ThemeProvider } from '@oss/react-sdk';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={{ baseUrl: API_URL }}>
        <ThemeProvider preset="midnightSapphire">
          <UIProvider value={daisyuiProvider}>{children}</UIProvider>
        </ThemeProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
