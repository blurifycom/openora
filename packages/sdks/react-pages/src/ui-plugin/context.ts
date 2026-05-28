import type { ReactNode } from 'react';

export type AppShellNavItem = {
  href: string;
  label: string;
  icon?: (props: { width?: number; height?: number; className?: string }) => ReactNode;
};

export type RegisteredRouteDescriptor = {
  path: string;
  element: ReactNode;
};

export type SlotFillMode = 'append' | 'prepend' | 'replace';

/**
 * Runtime context exposed to slot gating predicates. The host page seeds these
 * fields via `<SlotEvaluationContextProvider>` so plugins can declaratively gate
 * fills on user permissions, current brand, and active feature flags.
 */
export type SlotEvaluationContext = {
  /** Set of permission strings held by the current user. */
  permissions: ReadonlySet<string>;
  /** Active brand id (multi-brand operators), or null in single-brand mode. */
  brand: string | null;
  /** Feature flag map, eg `{ vipTier: true }`. */
  features: Readonly<Record<string, boolean>>;
};

/**
 * Optional gating properties common to slot contributions and column
 * contributions. All are checked in the registry consumer:
 *
 *   featureFlag → brandScope → requiresPermission → visibleWhen
 *
 * A fill renders only when every set property is satisfied.
 */
export type SlotGatingProps = {
  /** Runtime predicate; receives the evaluation context. */
  visibleWhen?: (ctx: SlotEvaluationContext) => boolean;
  /** Permission string(s) required; checked against `ctx.permissions`. */
  requiresPermission?: string | readonly string[];
  /** Brand ids this fill is scoped to; omit to match all brands. */
  brandScope?: readonly string[];
  /** Feature flag name; truthy in `ctx.features` to render. */
  featureFlag?: string;
};

/**
 * A component slot contribution declared in a UIPlugin.
 * Use defineSlotFill<T>(render) to get type-safe subject access.
 */
export type SlotContribution = SlotGatingProps & {
  /** Slot name - use SLOTS constant (e.g. SLOTS.playerDetail.sections) */
  name: string;
  /** Unique within the plugin */
  id: string;
  mode?: SlotFillMode;
  /** Lower order renders first. Default 100. */
  order?: number;
  render: (subject: unknown) => ReactNode;
};

/**
 * A DataTable column contribution declared in a UIPlugin.
 * Use SLOTS column names (e.g. SLOTS.players.columns).
 */
export type ColumnContribution = SlotGatingProps & {
  /** Column slot name - use SLOTS constant */
  name: string;
  key: string;
  header: string;
  render?: (value: unknown, row: Record<string, unknown>) => ReactNode;
};

/** Internal registry entry produced by buildRegistry */
export type SlotFill = SlotGatingProps & {
  id: string;
  pluginId: string;
  order: number;
  mode: SlotFillMode;
  render: (subject: unknown) => ReactNode;
};

/** Internal registry entry for a column. Carries gating same as a slot fill. */
export type ColumnFill = SlotGatingProps & {
  pluginId: string;
  key: string;
  header: string;
  render?: (value: unknown, row: Record<string, unknown>) => ReactNode;
};

/**
 * Immutable snapshot of all plugin contributions.
 * Pages read via useSlotFills(name) and useSlotColumns(name).
 */
export type UIRegistry = {
  slots: Map<string, SlotFill[]>;
  columns: Map<string, ColumnFill[]>;
  nav: AppShellNavItem[];
  routes: RegisteredRouteDescriptor[];
};

export const emptyRegistry: UIRegistry = {
  slots: new Map(),
  columns: new Map(),
  nav: [],
  routes: [],
};

/**
 * Resolve a fill's gating predicates against the evaluation context.
 * Order: featureFlag → brandScope → requiresPermission → visibleWhen.
 * All checks pass when their property is undefined.
 */
export function isFillVisible(
  fill: SlotGatingProps,
  ctx: SlotEvaluationContext,
): boolean {
  if (fill.featureFlag && !ctx.features[fill.featureFlag]) return false;
  if (fill.brandScope && fill.brandScope.length > 0) {
    if (ctx.brand === null || !fill.brandScope.includes(ctx.brand)) return false;
  }
  if (fill.requiresPermission !== undefined) {
    const need = Array.isArray(fill.requiresPermission)
      ? fill.requiresPermission
      : [fill.requiresPermission];
    for (const p of need) {
      if (!ctx.permissions.has(p)) return false;
    }
  }
  if (fill.visibleWhen && !fill.visibleWhen(ctx)) return false;
  return true;
}

/**
 * Default permissive evaluation context used when no provider is in scope -
 * keeps existing slots backwards-compatible: anything without gating renders;
 * anything with a featureFlag stays hidden until the flag is wired.
 */
export const defaultSlotEvaluationContext: SlotEvaluationContext = {
  permissions: new Set(),
  brand: null,
  features: {},
};
