'use client';

import type { ReactNode } from 'react';
import { OssProviders } from '@oss/react-pages';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <OssProviders apiUrl={API_URL} uiProvider={daisyuiProvider}>
      {children}
    </OssProviders>
  );
}
