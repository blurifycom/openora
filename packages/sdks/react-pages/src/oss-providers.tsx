'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIProvider as UIProviderShape } from '@oss/ui-provider-contract';
import { ApiClientProvider } from '@oss/react-hooks';
import { ThemeProvider, type ThemePresetName, type Theme } from './theme.js';
import { UIProvider } from '@oss/react-hooks';
import { UIPluginProvider, type UIPlugin } from './ui-plugin/index.js';

export type OssProvidersProps = {
  apiUrl: string;
  uiProvider: UIProviderShape;
  themePreset?: ThemePresetName;
  theme?: Partial<Theme>;
  plugins?: UIPlugin[];
  queryClient?: QueryClient;
  children: ReactNode;
};

export function OssProviders({
  apiUrl,
  uiProvider,
  themePreset,
  theme,
  plugins = [],
  queryClient: externalQC,
  children,
}: OssProvidersProps) {
  const [defaultQC] = useState(() => new QueryClient());
  const qc = externalQC ?? defaultQC;

  return (
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={{ baseUrl: apiUrl }}>
        <ThemeProvider {...(themePreset ? { preset: themePreset } : {})} {...(theme ? { theme } : {})}>
          <UIProvider value={uiProvider}>
            <UIPluginProvider plugins={plugins}>{children}</UIPluginProvider>
          </UIProvider>
        </ThemeProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
