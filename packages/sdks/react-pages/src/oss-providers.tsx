'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIProvider as UIProviderShape } from '@oss/ui-provider-contract';
import { ApiClientProvider, useCurrentUser, UIProvider } from '@oss/react-hooks';
import { ThemeProvider, useActiveBrand, type ThemePresetName, type Theme } from './theme.js';
import { SlotEvaluationContextProvider, UIPluginProvider, type UIPlugin } from './ui-plugin/index.js';

export type OssProvidersProps = {
  apiUrl: string;
  uiProvider: UIProviderShape;
  themePreset?: ThemePresetName;
  theme?: Partial<Theme>;
  plugins?: UIPlugin[];
  /**
   * Feature flags evaluated against `featureFlag` props on slot fills. Operators
   * pass this in from their own config source (eg PlatformConfig YAML, env, or
   * a `/platform/config/public` endpoint - not shipped yet).
   */
  features?: Record<string, boolean>;
  queryClient?: QueryClient;
  children: ReactNode;
};

/**
 * Reads the live brand + auth permissions and seeds `SlotEvaluationContextProvider`.
 * Lives below ThemeProvider + ApiClientProvider so it can call those hooks.
 */
function SlotEvaluationBridge({
  features,
  children,
}: {
  features: Record<string, boolean>;
  children: ReactNode;
}) {
  const brand = useActiveBrand();
  const userQuery = useCurrentUser();
  const permissions = useMemo(() => userQuery.data?.permissions ?? [], [userQuery.data]);
  return (
    <SlotEvaluationContextProvider permissions={permissions} brand={brand} features={features}>
      {children}
    </SlotEvaluationContextProvider>
  );
}

export function OssProviders({
  apiUrl,
  uiProvider,
  themePreset,
  theme,
  plugins = [],
  features = {},
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
            <SlotEvaluationBridge features={features}>
              <UIPluginProvider plugins={plugins}>{children}</UIPluginProvider>
            </SlotEvaluationBridge>
          </UIProvider>
        </ThemeProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
