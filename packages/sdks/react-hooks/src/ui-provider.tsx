'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { UIProvider as UIProviderShape } from '@oss/ui-provider-contract';

const UIContext = createContext<UIProviderShape | null>(null);

export function UIProvider({ value, children }: { value: UIProviderShape; children: ReactNode }) {
  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

export function useUI(): UIProviderShape {
  const ctx = useContext(UIContext);
  if (!ctx) {
    throw new Error(
      '@oss/react-hooks: useUI() called without <UIProvider value={...}> ancestor. Wrap your app with a UI adapter (eg @oss/ui-provider-daisyui).',
    );
  }
  return ctx;
}
