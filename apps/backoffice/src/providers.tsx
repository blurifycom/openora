import type { ReactNode } from 'react';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { OssProviders, type UIPlugin } from '@oss/react-pages';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';
import { vipTierPlugin } from '@oss/example-vip-tier';

const API_URL = import.meta.env.VITE_PUBLIC_API_URL ?? 'http://localhost:3001';

// Define plugins at module scope - never inline in JSX.
// A new array reference on every render re-runs buildRegistry and resets error boundaries.
// The example VIP plugin is dev-only so production builds ship without it.
const plugins: UIPlugin[] = import.meta.env.DEV ? [vipTierPlugin] : [];
const features: Record<string, boolean> = import.meta.env.DEV ? { vipTier: true } : {};

export function Providers({ children }: { children: ReactNode }) {
  return (
    <OssProviders apiUrl={API_URL} uiProvider={daisyuiProvider} plugins={plugins} features={features}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </OssProviders>
  );
}
