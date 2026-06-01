'use client';

import type { ComponentProps } from 'react';
import NextLink from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { NavigationAdapter, NavLinkProps } from '@oss/react-hooks';

/**
 * Next.js host implementation of the `@oss/react-hooks` navigation seam.
 * Passed to `<OssProviders navigationAdapter={nextNavigationAdapter}>` so SDK
 * pages navigate through Next's router/link without importing `next/*` themselves.
 */
export const nextNavigationAdapter: NavigationAdapter = {
  usePathname: () => usePathname() ?? '/',
  useNavigate: () => {
    const router = useRouter();
    return { push: (href) => router.push(href), replace: (href) => router.replace(href) };
  },
  useSearchParam: (key) => useSearchParams().get(key),
  Link: ({ href, children, ...rest }: NavLinkProps) => (
    <NextLink href={href} {...(rest as Omit<ComponentProps<typeof NextLink>, 'href'>)}>
      {children}
    </NextLink>
  ),
};
