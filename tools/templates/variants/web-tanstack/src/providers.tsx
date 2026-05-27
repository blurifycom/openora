import type { ReactNode } from 'react';
import { OssProviders } from '@oss/react-sdk';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';

// Public API URL the browser talks to. The server loaders use INTERNAL_API_URL
// (see src/server/api.ts) for the same surface.
const API_URL = import.meta.env.VITE_PUBLIC_API_URL ?? 'http://localhost:3001';

// DaisyUI is the single adapter shipped by the platform. Swap in your own adapter
// here (same @oss/ui-provider-contract, no page changes).
export function Providers({ children }: { children: ReactNode }) {
  return (
    <OssProviders apiUrl={API_URL} uiProvider={daisyuiProvider} themePreset="midnightSapphire">
      {children}
    </OssProviders>
  );
}
