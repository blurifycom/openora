import { Link as RouterLink, useNavigate, useRouterState } from '@tanstack/react-router';
import type { NavigationAdapter, NavLinkProps } from '@oss/react-hooks';

/**
 * TanStack Router host implementation of the `@oss/react-hooks` navigation seam.
 * Passed to `<OssProviders navigationAdapter={tanstackNavigationAdapter}>` so the
 * SDK pages navigate through TanStack Router instead of `next/*` (which reads
 * `process.env` and crashes in a Vite browser bundle).
 *
 * SDK pages pass already-resolved string paths (eg `/players/abc123`), so we
 * cast past TanStack's typed-route `to` checking - the routes exist at runtime.
 */
export const tanstackNavigationAdapter: NavigationAdapter = {
  usePathname: () => useRouterState({ select: (s) => s.location.pathname }),
  useNavigate: () => {
    const navigate = useNavigate();
    return {
      push: (href) => void navigate({ to: href } as never),
      replace: (href) => void navigate({ to: href, replace: true } as never),
    };
  },
  useSearchParam: (key) => {
    const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
    const value = search[key];
    return value === null || value === undefined ? null : String(value);
  },
  // SDK pages only ever pass `className` to <Link>; forward that and drop the
  // other anchor attrs rather than fight TanStack's strict typed-link props.
  Link: ({ href, className, children }: NavLinkProps) => (
    <RouterLink to={href as never} className={className}>
      {children}
    </RouterLink>
  ),
};
