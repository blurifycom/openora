export { defineUIPlugin, buildRegistry, type UIPlugin } from './define.js';
export {
  UIPluginProvider,
  RegisteredRoute,
  useUIRegistry,
  useNavItems,
  useRegisteredRoutes,
} from './registry.js';
export { Slot, useSlotFills, useSlotColumns, defineSlotFill, type SlotProps } from './slot.js';
export { SLOTS, type SlotName, type ColumnSlotName } from './slots.js';
export type {
  AppShellNavItem,
  RegisteredRouteDescriptor,
  UIRegistry,
  SlotFill,
  SlotFillMode,
  SlotContribution,
  ColumnContribution,
} from './context.js';
