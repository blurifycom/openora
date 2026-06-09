import type { ReactNode } from 'react';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { OssProviders, type UIPlugin } from '@oss/react-pages';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';
import { tanstackNavigationAdapter } from './navigation-adapter';

const API_URL = import.meta.env.VITE_PUBLIC_API_URL ?? 'http://localhost:3001';

// No UI plugins ship by default. Register your own defineUIPlugin slot fills here.
// Define them at module scope - never inline in JSX: a new array reference on
// every render re-runs buildRegistry and resets error boundaries.
const plugins: UIPlugin[] = [];
const features: Record<string, boolean> = {};

export function Providers({ children }: { children: ReactNode }) {
  return (
    <OssProviders
      apiUrl={API_URL}
      uiProvider={daisyuiProvider}
      plugins={plugins}
      features={features}
      navigationAdapter={tanstackNavigationAdapter}
    >
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </OssProviders>
  );
}
