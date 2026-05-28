'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * Generic per-page data context. Composed pages (eg `<AdminUsersPage>`,
 * `<PlayerDetailPage>`) wrap their body in `<PageContextProvider value={{...}}>`
 * exposing the data they've already loaded. Plugin-contributed slot fills
 * inside that page can then read it via `usePageContext()` without re-fetching.
 *
 * The page declares the shape:
 *
 *   type PlayerDetailContext = { player: Player; isLoading: boolean };
 *   <PageContextProvider value={{ player, isLoading }}>
 *     <Slot name={SLOTS.playerDetail.sections} subject={player}>...</Slot>
 *   </PageContextProvider>
 *
 * A plugin contributor reads with the same shape:
 *
 *   const { player } = usePageContext<PlayerDetailContext>();
 *
 * If a slot is rendered outside any provider, the hook throws. This is the
 * intended failure mode - it surfaces a misconfiguration at the source.
 */
const PageContext = createContext<unknown | null>(null);

export function PageContextProvider<T>({
  value,
  children,
}: {
  value: T;
  children: ReactNode;
}) {
  // Stable identity per provider mount; the page's own useMemo around `value`
  // is the right place to dedupe on prop equality.
  const stable = useMemo(() => value, [value]);
  return <PageContext.Provider value={stable}>{children}</PageContext.Provider>;
}

export function usePageContext<T>(): T {
  const value = useContext(PageContext);
  if (value === null) {
    throw new Error(
      '@oss/react-hooks: usePageContext() called outside <PageContextProvider>. ' +
        'Page must wrap its body with <PageContextProvider value={...}> before ' +
        'rendering slots that read page-scoped data.',
    );
  }
  return value as T;
}

/** Non-throwing variant; returns null when no provider is in scope. */
export function useOptionalPageContext<T>(): T | null {
  return useContext(PageContext) as T | null;
}
