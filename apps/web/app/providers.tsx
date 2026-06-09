'use client';

import type { ReactNode } from 'react';
import { OssProviders, type UIPlugin } from '@oss/react-pages';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';
import { nextNavigationAdapter } from './navigation-adapter';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// No UI plugins ship by default. Register your own defineUIPlugin slot fills here
// (see ADR-0013). Keep the array at module scope - a fresh reference each render
// re-runs buildRegistry and resets error boundaries.
const plugins: UIPlugin[] = [];
const features: Record<string, boolean> = {};

export function Providers({ children }: { children: ReactNode }) {
  return (
    <OssProviders
      apiUrl={API_URL}
      uiProvider={daisyuiProvider}
      plugins={plugins}
      features={features}
      navigationAdapter={nextNavigationAdapter}
    >
      {children}
    </OssProviders>
  );
}
