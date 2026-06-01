'use client';

import type { ReactNode } from 'react';
import { OssProviders, type UIPlugin } from '@oss/react-pages';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';
import { vipTierPlugin } from '@oss/example-vip-tier';
import { nextNavigationAdapter } from './navigation-adapter';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Dev-only: example plugin demonstrates slot fills + gating. Production builds
// ship with an empty plugin list.
const isDev = process.env.NODE_ENV !== 'production';
const plugins: UIPlugin[] = isDev ? [vipTierPlugin] : [];
const features: Record<string, boolean> = isDev ? { vipTier: true } : {};

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
