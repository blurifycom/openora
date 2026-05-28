'use client';

import { Component, type ReactNode } from 'react';
import type { TableColumn } from '@oss/ui-provider-contract';
import type { SlotFill } from './context.js';
import { useUIRegistry } from './registry.js';

class SlotErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; fillId: string },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      console.error(`[slot] fill "${this.props.fillId}" crashed:`, this.state.error);
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}

/** All fills registered for a named slot, sorted by order. */
export function useSlotFills(name: string): SlotFill[] {
  return useUIRegistry().slots.get(name) ?? [];
}

/** Extra DataTable columns registered for a named column slot. */
export function useSlotColumns(name: string): TableColumn<Record<string, unknown>>[] {
  return useUIRegistry().columns.get(name) ?? [];
}

export type SlotProps<T = void> = {
  name: string;
  subject?: T;
  /** Page default content. Suppressed when a replace fill is active. */
  children?: ReactNode;
  /** Shown inside the error boundary when a fill crashes. Default: null (silent). */
  fillFallback?: ReactNode;
};

/**
 * Declare a UI injection point in a page.
 *
 * Render order:
 *   [prepend fills] → [children OR replace fill] → [append fills]
 *
 * Each fill is wrapped in an error boundary - a crashing fill is silenced
 * without taking down the rest of the page.
 *
 * @example
 * <Slot name={SLOTS.playerDetail.sections} subject={player}>
 *   <DefaultInfoSection player={player} />
 * </Slot>
 */
export function Slot<T = void>({ name, subject, children, fillFallback }: SlotProps<T>): ReactNode {
  const fills = useSlotFills(name);
  const prepend = fills.filter((f) => f.mode === 'prepend');
  const append = fills.filter((f) => f.mode === 'append');
  const replaces = fills.filter((f) => f.mode === 'replace');
  const active = replaces.at(-1);

  return (
    <>
      {prepend.map((f) => (
        <SlotErrorBoundary key={f.id} fillId={f.id} fallback={fillFallback}>
          {f.render(subject) as ReactNode}
        </SlotErrorBoundary>
      ))}
      {active ? (
        <SlotErrorBoundary fillId={active.id} fallback={fillFallback}>
          {active.render(subject) as ReactNode}
        </SlotErrorBoundary>
      ) : (
        children
      )}
      {append.map((f) => (
        <SlotErrorBoundary key={f.id} fillId={f.id} fallback={fillFallback}>
          {f.render(subject) as ReactNode}
        </SlotErrorBoundary>
      ))}
    </>
  );
}

/**
 * Type-safe helper for plugin authors. Avoids the unknown cast inside render.
 *
 * @example
 * ctx.slots.fill(
 *   SLOTS.playerDetail.sections,
 *   { id: 'badges', mode: 'append', order: 40 },
 *   defineSlotFill<Player>(player => <BadgesSection playerId={player.id} />),
 * );
 */
export function defineSlotFill<T>(
  render: (subject: T) => ReactNode,
): (subject: unknown) => ReactNode {
  return (subject) => render(subject as T);
}
