'use client';

import {
  createContext,
  createElement,
  useContext,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
} from 'react';

/**
 * Framework-agnostic navigation seam.
 *
 * The SDK pages/blocks run in two different hosts - the Next.js `web` app and
 * the Vite + TanStack Router `backoffice` - so they must NOT import `next/link`
 * or `next/navigation` directly (Next's client runtime reads `process.env`,
 * which is undefined in a Vite browser bundle -> "process is not defined").
 *
 * Instead each host implements this adapter once and passes it to
 * `OssProviders navigationAdapter={...}`. Pages call `useNavigate`, `usePathname`,
 * `useSearchParam`, and render `<Link>` from `@oss/react-hooks`.
 */

export type Navigate = {
  push: (href: string) => void;
  replace: (href: string) => void;
};

export type NavLinkProps = {
  href: string;
  children?: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

export type NavigationAdapter = {
  usePathname: () => string;
  useNavigate: () => Navigate;
  useSearchParam: (key: string) => string | null;
  Link: ComponentType<NavLinkProps>;
};

const NavigationContext = createContext<NavigationAdapter | null>(null);

export function NavigationProvider({
  adapter,
  children,
}: {
  adapter: NavigationAdapter;
  children: ReactNode;
}) {
  return createElement(NavigationContext.Provider, { value: adapter }, children);
}

function useNavigationAdapter(): NavigationAdapter {
  const adapter = useContext(NavigationContext);
  if (!adapter) {
    throw new Error(
      'NavigationProvider is missing. Pass a host navigation adapter to ' +
        '<OssProviders navigationAdapter={...}> (a Next adapter in the web app, ' +
        'a TanStack Router adapter in the backoffice).',
    );
  }
  return adapter;
}

// The adapter object is stable for the lifetime of the app (defined at module
// scope in each host), so calling its hooks through these wrappers keeps a
// stable hook order.
export function usePathname(): string {
  return useNavigationAdapter().usePathname();
}

export function useNavigate(): Navigate {
  return useNavigationAdapter().useNavigate();
}

export function useSearchParam(key: string): string | null {
  return useNavigationAdapter().useSearchParam(key);
}

export function Link(props: NavLinkProps) {
  const { Link: HostLink } = useNavigationAdapter();
  return createElement(HostLink, props);
}
