import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientProvider, UIProvider, ThemeProvider } from '@oss/react-sdk';
import { shadcnProvider } from '@oss/ui-provider-shadcn';

// Public API URL the browser talks to. The server loaders use INTERNAL_API_URL
// (see src/server/api.ts) for the same surface.
const API_URL = import.meta.env.VITE_PUBLIC_API_URL ?? 'http://localhost:3001';

// shadcn is kept here as the OSS default; the Consumer POC swaps to daisyuiProvider
// from '@oss/ui-provider-daisyui' (same @oss/ui-provider-contract, no page changes).
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={{ baseUrl: API_URL }}>
        <ThemeProvider preset="midnightSapphire">
          <UIProvider value={shadcnProvider}>{children}</UIProvider>
        </ThemeProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
