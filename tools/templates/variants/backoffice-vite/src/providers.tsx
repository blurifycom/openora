import type { ReactNode } from 'react';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { OssProviders, type UIPlugin } from '@oss/react-pages';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';

const API_URL = import.meta.env.VITE_PUBLIC_API_URL ?? 'http://localhost:3001';

// Add defineUIPlugin contributions here (nav items, columns, tiles). See ADR-0006.
// Module scope - never inline in JSX (a new array each render resets the registry).
const plugins: UIPlugin[] = [];

export function Providers({ children }: { children: ReactNode }) {
  return (
    <OssProviders apiUrl={API_URL} uiProvider={daisyuiProvider} plugins={plugins}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </OssProviders>
  );
}
