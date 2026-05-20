import { createContext, useContext } from 'react';
import type { UIProvider } from '@oss/ui-provider-contract';
import { shadcnProvider } from '@oss/ui-provider-shadcn';

/**
 * Registry of UI adapters. Stories render against whichever adapter is active
 * in the toolbar. To add a new adapter (eg MUI), build its provider package,
 * then add one line here - every existing story renders through it instantly.
 * That is the conformance check: identical stories, every adapter.
 */
export const adapters: Record<string, UIProvider> = {
  shadcn: shadcnProvider,
  // mui: muiProvider,
  // antd: antdProvider,
};

export const adapterNames = Object.keys(adapters);
export const defaultAdapter = 'shadcn';

const AdapterContext = createContext<UIProvider>(shadcnProvider);
export const AdapterProvider = AdapterContext.Provider;

/** Storybook-local mirror of react-sdk's useUI - keeps Storybook off the
 * react-sdk barrel (which imports next/navigation). */
export function useUI(): UIProvider {
  return useContext(AdapterContext);
}
