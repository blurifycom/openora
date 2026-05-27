import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientProvider, UIProvider, ThemeProvider } from '@oss/react-sdk';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';

// Public API URL the browser talks to. The server loaders use INTERNAL_API_URL
// (see src/server/api.ts) for the same surface.
const API_URL = import.meta.env.VITE_PUBLIC_API_URL ?? 'http://localhost:3001';

// DaisyUI is the single adapter shipped by the platform. Swap in your own adapter
// here (same @oss/ui-provider-contract, no page changes).
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
