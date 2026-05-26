import type { ReactNode } from 'react';
import type { TableColumn } from '@oss/ui-provider-contract';

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
 * A component slot contribution declared in a UIPlugin.
 * Use defineSlotFill<T>(render) to get type-safe subject access.
 */
export type SlotContribution = {
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
export type ColumnContribution = {
  /** Column slot name - use SLOTS constant */
  name: string;
  key: string;
  header: string;
  render?: (value: unknown, row: Record<string, unknown>) => ReactNode;
};

/** Internal registry entry produced by buildRegistry */
export type SlotFill = {
  id: string;
  pluginId: string;
  order: number;
  mode: SlotFillMode;
  render: (subject: unknown) => ReactNode;
};

/**
 * Immutable snapshot of all plugin contributions.
 * Pages read via useSlotFills(name) and useSlotColumns(name).
 */
export type UIRegistry = {
  slots: Map<string, SlotFill[]>;
  columns: Map<string, TableColumn<Record<string, unknown>>[]>;
  nav: AppShellNavItem[];
  routes: RegisteredRouteDescriptor[];
};

export const emptyRegistry: UIRegistry = {
  slots: new Map(),
  columns: new Map(),
  nav: [],
  routes: [],
};
