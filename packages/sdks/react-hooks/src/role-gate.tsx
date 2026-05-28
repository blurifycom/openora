'use client';

import type { ReactNode } from 'react';
import { useCurrentUser } from './hooks/user.js';

/**
 * Conditionally render based on the current user's role / permissions.
 *
 * Three overlapping props - use the one that matches your check:
 *
 * - `role`: matches `currentUser.role` against one of the listed values.
 * - `permission`: requires *all* listed permission strings on the user
 *   (string vs string[]). Plug into the platform's RBAC permission set.
 * - `predicate`: arbitrary predicate against the current user object.
 *
 * Hides content silently when access is denied. Pass `fallback` to show a
 * "no access" placeholder.
 *
 * For data-side RBAC use the server enforcement (`AdminGuard` / contract
 * guards). `<RoleGate>` is for UI hiding only - never the only authority.
 *
 * @example
 *   <RoleGate role={['admin', 'superadmin']}>
 *     <DangerousButton />
 *   </RoleGate>
 *
 *   <RoleGate permission="players:write:limits">
 *     <EditLimitsForm />
 *   </RoleGate>
 */
export function RoleGate({
  role,
  permission,
  predicate,
  fallback = null,
  children,
}: {
  role?: string | readonly string[];
  permission?: string | readonly string[];
  predicate?: (user: CurrentUserShape | null) => boolean;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const user = useCurrentUser() as CurrentUserShape | null;

  if (!user) return <>{fallback}</>;

  if (role !== undefined) {
    const allowed = Array.isArray(role) ? role : [role];
    if (!allowed.includes(user.role ?? '')) return <>{fallback}</>;
  }

  if (permission !== undefined) {
    const required = Array.isArray(permission) ? permission : [permission];
    const granted = new Set(user.permissions ?? []);
    for (const p of required) {
      if (!granted.has(p)) return <>{fallback}</>;
    }
  }

  if (predicate && !predicate(user)) return <>{fallback}</>;

  return <>{children}</>;
}

/**
 * Minimal shape `<RoleGate>` reads. Wider than the contract's AdminUser - role
 * + permissions are optional, since not every consumer wires permission strings.
 * The real auth shape will satisfy this structurally.
 */
type CurrentUserShape = {
  id?: string;
  role?: string;
  permissions?: readonly string[];
};
